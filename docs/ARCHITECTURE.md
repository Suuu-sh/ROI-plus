# アーキテクチャと作業ガイド

この文書はリポジトリのコード・設定から確認できる構成を説明する。製品の目標と不変条件は [SPEC](SPEC.md)、実装の根拠は本文中に示したコード／設定を参照する。仕様と実装が異なる場合はどちらかを黙って正本扱いせず、差分を報告する。Cloudflare の管理画面、GitHub の Secret 設定、実行中環境の状態はこのリポジトリからは確定できない。

## 目標と現状の区別

| 項目 | 製品設計・目標 | リポジトリで確認できる実装 |
|---|---|---|
| 対象 | 競馬（JRA）とボートレース | 日次 Actions、公式データ収集、Worker Cron はボート中心。競馬はユーザー提供 CSV の取込・特徴量コードがあるが、JRA 自動収集はない。 |
| 予測 | 出典のあるデータを用いた AI 予測 | Python / LightGBM が学習・推論を行い、Worker はモデルを実行しない。アプリコードに LLM / GPT API 呼び出しは見当たらない。毎週の自動学習対象は boat。 |
| 購入 | 仮想運用のみ | `POST /api/bets` と Cron の自動購入は D1 の仮想 bet 記録のみ。投票・決済連携はない。現在の API の bet 操作は単勝 (`win`)。 |
| オッズ | 取得許諾・頻度の制約を守る | Worker の Cron に公式単勝オッズ収集器がある。実装 (`apps/api/src/services/collectBoatraceOdds.ts`) は現在時刻から締切まで15分以内を対象にするが、SPEC は25分以内としており差分がある。実装は最大30レースを対象にし、各対象で1回リトライ、Worker 全体の fetch 試行上限は49。SPEC の「最大30リクエスト」とは上限の数え方が異なる。README は許諾未確認を理由に既定無効と説明し、`apps/api/wrangler.toml` は `ENABLE_BOATRACE_ODDS_SCRAPE` と `ENABLE_AUTO_BET` を有効値に設定している。これらは文書／設定上の情報であり、デプロイ済み設定や許諾を意味しない。確認なしに本番収集・フラグ変更をしない。 |
| モデル管理 | 評価後に人が昇格・ロールバック | 学習結果は `candidate` として同期される。Worker API に手動昇格・ロールバック操作があり、学習 Action は昇格しない。 |

## システム構成

```text
ブラウザー
  └─ Cloudflare Worker `roi-plus` (apps/web)
       ├─ dist の SPA 静的配信
       └─ `/api/*` を Service Binding `API` で中継
            └─ Cloudflare Worker `roi-plus-api` (Hono)
                 └─ D1 binding `DB` (SQLite / db/migrations)

GitHub Actions / ローカル Python (ml/)
  ├─ 公式ボートレース B/K データ収集・正規化
  ├─ 特徴量化・LightGBM 学習または推論
  └─ Bearer 認証付き `/api/ingest/*` → API Worker → D1
```

- **Web**: React + TypeScript + Vite + Tailwind。Worker の `assets` 設定が `apps/web/dist` を配信し、SPA fallback を行う。`apps/web/worker.ts` が `/api/*` を API Service Binding に渡し、`PROXY_TOKEN` をヘッダーに付加する。Cloudflare Access の実際のポリシーは外部設定。
- **API**: Hono の base path は `/api`。Web/API の永続 DB は D1（ML pipeline は別途ローカル JSON store を使う）で、スキーマ変更は `db/migrations/`。Worker の Service Binding 経由の閲覧 API は `PROXY_TOKEN` を検証し、ingest と `/admin/settle` は `INGEST_TOKEN` を Bearer 認証する。`/health` はヘルス確認用。
- **D1 / 共有ロジック**: スキーマ・初期設定は `db/migrations/`、サンプル投入は `db/seed/`。型と EV 判定は `packages/shared/`。行の自然キーに UNIQUE 制約があり、ingest は upsert を行う。

### API の主な面

`GET /api/races`, `/api/races/:id`, `/api/rankings`, `/api/bets`, `/api/performance/*`, `/api/models`, `/api/collection/status` が読み取り面。`POST /api/bets` は仮想単勝、`POST /api/models/:id/promote|rollback` はモデル管理、`POST /api/ingest/{venues,races,entries,results,payouts,odds,predictions,models,collection-runs}` は Python 等からの冪等同期。`POST /api/admin/settle` は認証付き精算操作。多くの読み取り API は `origin=sample|real|all` で出所を絞れる。実際の入出力契約は `apps/api/src/index.ts` と `packages/shared/src/types.ts` が根拠。

## AI・データフロー

1. `ml/edgelab/collectors/` が公式ボートレース B/K ファイルを取得し、`parsers/` が正規化する。日次処理はローカル JSON store を再利用し、再実行できる自然キーでデータをまとめる。
2. `features/` は許可した数値特徴量だけを作る。`available_at <= predicted_at` と同日・未来情報の除外を検査する。結果／払戻などを特徴量に混入させないため、特徴量列は allowlist で制限される。
3. `ml/edgelab/models/train.py` は時系列で train / validation / test を分割して LightGBM を学習し、検証データで温度校正する。レース単位 bootstrap の出力ばらつきが `prob_std`。十分なデータがない場合は暗黙に代替モデルを使わず `untrained` とする。成果物は `ml/artifacts/`。
4. `ml/edgelab/predict.py` は確率と不確実性を出し、`ml/edgelab/sync.py` が 500 行以下のチャンクで ingest API へ送る。Worker は予測を再計算せず、`packages/shared/src/ev.ts` の規則に沿う評価・候補表示と仮想運用を行う。
5. 日次 Action の `python -m edgelab daily` は前日・当日の B/K 収集、当日の予測、同期を行い、その後に履歴 backfill を試みる。予測には active モデルがあればそれを使い、なければ最新 candidate を選ぶ。対応する artifact がない場合は fail closed する。
6. 週次 Action は `python -m edgelab train --sport boat` とモデル行の同期のみ。候補モデルの本番昇格・ロールバックは人が画面/APIから行う。

Worker の `*/10 * * * *` Cron は、オッズ収集フラグが有効なら対象レースの公式単勝オッズを取得し、open bet 精算、自動**仮想**購入、古いオッズ削除を順に行う。実装上、オッズ取得には締切前の時間窓、最大リクエスト数、間隔、重複防止ロックがある。許諾・本番の設定状態はコードだけでは確認できない。

### 仮想バンクロールと bet の制御

- 初期値は `initial_bankroll=100000` 円、`unit_stake=100` 円。どちらも D1 の `settings` で管理される。
- 手動・自動とも単勝の仮想 bet のみ。手動 bet は正の `unit_stake` 倍数、自動 bet は1単位を stake にする。投票サイトや決済には接続しない。
- 自動購入は Worker の `ENABLE_AUTO_BET=true` または D1 `auto_bet_enabled=true` のどちらかで有効になる。最新予測のモデルが `active` で、オッズがあり、`min_expected_roi`（初期値 0.05）以上かつ `HIGH_EDGE` / `POSITIVE_EDGE` 判定の候補だけを対象とする。`max_prob_std`（初期値 0.05）を超える予測は edge 判定で除外される。週次学習で作られた `candidate` モデルは自動購入に使われない。
- bet を挿入する SQL 自体が利用可能額を条件にする。利用可能額は `初期 bankroll + 確定 bet の profit 合計 - open bet の stake 合計`。判定と挿入を同じ SQL 文で行い、同時実行で残高上限をすり抜けないようにしている。自動 bet はさらにレースごとの一意制約で重複を防ぐ。
- `/performance/overview` の `bankroll` は確定分の損益だけを初期値に加えた表示で、open bet の stake を差し引いた「今すぐ使える額」とは別。利用可能額の判定根拠は `apps/api/src/index.ts` の `availableBankrollSql`。
- `void` は払戻 0・profit 0 で精算される。open stake は精算まで利用可能額から控除される。

## データ安全・重要な不変条件

- `data_origin` は `sample` / `real` を分離する。合成 fixture はテスト用。公式実データ・予測・オッズ・結果をサンプルや補完値で代替しない。取得不能値は欠損のまま扱う。
- 予測時点で未公開の情報を使わない。特に結果を学習特徴量にしない。新しい特徴量・collector を追加するときは `available_at` と時刻の意味をテストする。
- ingest は自然キー upsert 前提。再実行で重複や新しい `data_origin` の混入を起こさない。サンプルと実データを統合する変更はしない。
- 実購入・外部決済は存在しない。自動 bet も仮想 D1 レコード。モデル昇格は明示操作であり、学習や Actions に自動昇格を足さない。
- API / Actions / Wrangler の秘密は値ではなく変数名だけを扱う。該当名: `INGEST_TOKEN`, `PROXY_TOKEN`, `EDGELAB_API_URL`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`。Actions では日次 workflow が4名を参照し、retrain workflow は `EDGELAB_API_URL` と `INGEST_TOKEN` を参照する。Worker の非秘密フラグ名は `ENABLE_AUTO_BET`, `ENABLE_BOATRACE_ODDS_SCRAPE`。
- `data/raw/`, `data/private_fixtures/`, `ml/data/` はローカル／キャッシュ用途で、ignore 対象。公式データや運用 state を不用意に追加・出力しない。Wrangler のローカル秘密ファイルなど、秘密値を含むものも追跡・表示しない。
- `npm run dev` は起動前に `db:reset` を実行し、**ローカル D1 state を削除して**マイグレーションとサンプルを入れ直す。重要なローカルデータを保持したい場合は起動しない。

## GitHub Actions と変数名

- `.github/workflows/daily.yml`: cron は UTC `00:30`, `02:00`, `04:00`, `14:30`（JST 09:30, 11:00, 13:00, 23:30）と手動実行。朝の複数回は GitHub schedule の遅延・欠落に備える。Python 3.12 / Node 20 で日次 pipeline を実行する。
- `.github/workflows/retrain.yml`: 毎週月曜 UTC `02:41`（JST 11:41）と手動実行。boat モデルを学習し、`models` 行だけを同期する。
- Actions Secret 名は `EDGELAB_API_URL`, `INGEST_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`。値、アカウント ID の実値、ローカル保管場所は文書・ログ・チャットに書かない。Cloudflare Access の設定や Worker Secret はコード外で管理する。

## 開発・テスト・デプロイ

前提は Node.js 20+、Python 3.11+。リポジトリルートで:

```sh
npm ci
python3 -m venv ml/.venv
ml/.venv/bin/pip install -r ml/requirements.txt
npm run dev
```

`npm run dev` はローカル API (`127.0.0.1:8787`) と Web (`localhost:5180`) を同時起動し、ローカル D1 を初期化する。ingest を使う場合はローカル Worker に `INGEST_TOKEN` を安全に設定し、同期側にも同じ値を環境変数として渡す。秘密値をコマンド引数・シェル履歴・ログへ書かない。

```sh
npm test
npm run typecheck
ml/.venv/bin/python -m pytest ml/tests -q
npm -w apps/web run build
```

既存 Worker へのデプロイコマンドは次のとおり。いずれも Cloudflare の本番環境に変更を加えるため、明示的な依頼なしに実行しない。リモート D1 migration / SQL も同様。

```sh
npm -w apps/api run deploy
npm -w apps/web run deploy
```

ローカル D1 の初期化だけを行うコマンドは `npm run db:reset`（破壊的・ローカルのみ）。Wrangler 設定は `apps/api/wrangler.toml` と `apps/web/wrangler.jsonc`。ID や認証値は設定から転記・文書化しない。

## リポジトリマップ

| パス | 役割 |
|---|---|
| `apps/web/src/` | React 画面、API client、origin filter |
| `apps/web/worker.ts`, `apps/web/wrangler.jsonc` | Assets 配信、API Service Binding、Web Worker 設定 |
| `apps/api/src/index.ts` | Hono REST API、認証、ingest、仮想運用、Cron |
| `apps/api/src/services/`, `repo/` | オッズ取得・判定・D1 adapter |
| `apps/api/wrangler.toml` | API Worker / D1 binding / Cron / feature flags |
| `packages/shared/` | 共有型、期待値・判定・評価指標 |
| `db/migrations/`, `db/seed/` | D1 schema と sample data |
| `ml/edgelab/` | Python CLI、collector / parser / feature / model / prediction / sync |
| `ml/tests/`, `apps/*/test/`, `packages/shared/test/` | ML / Worker / UI / shared ロジックのテスト |
| `data/fixtures/` | 合成テスト fixture。公式実データを追加しない |
| `.github/workflows/` | 日次 pipeline と週次 retrain |
| `scripts/` | 手動運用用ラッパー。内容確認と本番影響確認なしに実行しない |
