# アーキテクチャと作業ガイド

この文書はリポジトリのコード・設定から確認できる構成を説明する。製品の目標と不変条件は [SPEC](SPEC.md)、実装の根拠は本文中に示したコード／設定を参照する。仕様と実装が異なる場合はどちらかを黙って正本扱いせず、差分を報告する。Cloudflare の管理画面、GitHub の Secret 設定、実行中環境の状態はこのリポジトリからは確定できない。

## 目標と現状の区別

| 項目 | 製品設計・目標 | リポジトリで確認できる実装 |
|---|---|---|
| 対象 | 競馬（JRA）とボートレース | 日次 Actions、公式データ収集、Worker Cron はボート中心。競馬はユーザー提供 CSV の取込・特徴量コードがあるが、JRA 自動収集はない。 |
| 予測 | 出典のあるデータを用いた AI 予測 | Python / LightGBM が学習・推論を行い、Worker はモデルを実行しない。アプリコードに LLM / GPT API 呼び出しは見当たらない。毎週の自動学習対象は boat。 |
| 購入 | 仮想運用のみ | `POST /api/bets` と Cron の自動購入は D1 の仮想 bet 記録のみ。投票・決済連携はない。現在の API の bet 操作は単勝 (`win`)。 |
| オッズ | 取得許諾・頻度の制約を守る | Worker に公式単勝オッズ収集器がある。毎分トリガーは締切まで15分以内・JST当日の実データを対象にし、直近50秒の取得を除外、最大30レース・各対象1回リトライ・取得間隔3秒以上・1回最大49 fetch 試行。空対象ならDBへ書き込まない。`settings.roi_d1_write_budget_utc` の推定共有予約上限は20,000 unit/UTC日、オッズ専用内数は10,000 unit/日である。日次同期・精算・他 Worker の書込は別であり、これはアカウント全体のD1残量を読み取るものではなく、実際の行書込数とも一致せず、対象カバレッジは保証しない。10分トリガーは精算・自動仮想購入・古いオッズ削除のみを行う。SPEC の単一Cron記述・25分以内・10分鮮度とは差分があり、SPEC は変更していない。`apps/api/wrangler.toml` のフラグ値は設定情報であり、デプロイ済み状態や許諾を意味しない。 |
| モデル管理 | 評価後に人が昇格・ロールバック | 学習結果は `candidate` として同期される。Worker API に手動昇格・ロールバック操作があり、学習 Action は昇格しない。 |

## システム構成

競技ページの主表示は `GET /api/bets?sport=&origin=` の保存済み仮想購入をレースごとにまとめる購入レビューである。賭け記録は購入時点で表示し、結果・払戻を照合する詳細だけを開いた時に `GET /api/races/:id` で取得する。購入時の確率・オッズ・期待収益率は bet の保存値を表示し、後日の予測や結果で置き換えない。着順・払戻が欠ける場合は欠損として示し、単一レースの結果から因果説明を生成しない。サンプル購入には出所バッジとサンプル結果の注記を表示する。日付フィルターは購入一覧とレース探索に共通し、「レースを調べる」内にランキング・出走表を残す。購入候補表示に結果を混入させない。

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

### D1 日次書込予算

- API Worker は、`settings.roi_d1_write_budget_utc` の UTC 日別カウンターで、この Worker が行う D1 書込を推定 20,000 unit/日以下に抑える。Cloudflare アカウント全体や他アプリの D1 quota を計測・予約する仕組みではなく、他サービスに残る実 quota は保証しない。移行・管理画面など Worker 外の D1 書込もカウンター対象外。
- オッズ収集には共有上限の内数として 10,000 unit/日を設ける。残りを ingest、精算、仮想購入、古いオッズ削除、モデル昇格・rollback 用に確保する。レコードとテーブル索引数をもとに保守的に見積もり、予約は再試行・途中失敗でも返却しない。
- `/api/ingest/*` は自然キーの既存行を索引検索し、NULL 安全な比較で変更がない場合は SQL を発行しない。上流の合成 `id`、同一内容の再送、race のみ変化した `updated_at` は更新根拠にしない。入力は最大500行/リクエスト。最大でも予約量が上限に達する場合は、HTTP 429 と `d1_write_budget_exhausted` を返す。カウンター欠落・破損・CAS 競合も fail-closed（欠落/破損は `d1_write_budget_unavailable`）とし、quota 増額や自動初期化はしない。
- オッズ収集、精算、auto/manual bet、古いオッズの削除、モデル昇格・rollback も同じ予約を通る。settlement はオッズ収集エラーと独立して動くが、共有予算が不明または尽きた場合は書込みを止める。
- 認証付き `GET /api/ingest/write-budget` で当日 UTC 日付・上限・予約済み・残量・状態を参照できる。未登録の初期化は人手の運用操作とし、旧利用量が不明な日は当日の全上限（20,000、うち odds 10,000）を予約する `POST /api/ingest/write-budget/seed` を使う。その UTC 日が終われば次の日付への CAS 予約でカウンターが切り替わる。ローカル DB ではテスト fixture が予算を明示的に seed する。

### API の主な面

閲覧系の `/api/races`・`/api/races/:id`・`/api/rankings`・`/api/models`・`/api/collection/status` は、`PROXY_TOKEN` が設定された環境で認証を通過した GET のみ Cloudflare Cache API に最大10秒保存する。URL全体（クエリを含む）でキーを分離し、200 JSON以外は保存しない。キャッシュ障害時はD1読み取りへフォールバックする。`/api/bets`・`/api/performance/*`・`/api/health`・ingest/admin と全書込系は対象外で、仮想購入の判断・記録は常にD1の最新状態を使う。Cloudflare Cache API は拠点ごとのキャッシュであり、全地域でのヒットやD1読み取り削減量は保証しない。

`GET /api/races`, `/api/races/:id`, `/api/rankings`, `/api/bets`, `/api/performance/*`, `/api/models`, `/api/collection/status` が読み取り面。`GET /api/ingest/models` は `INGEST_TOKEN` 認証付きのモデルレジストリ読み取りで、Pythonが人手昇格後の状態を確認する。`POST /api/bets` は仮想単勝で、複数選択は `{raceId, betType:'win', requestId?, selections:[{selection, stake}, ...]}`（1回1〜6件）を受け付け、ticket group 全体を1ステートメントで残高ガード付き記録する。`requestId` を指定すると同じ payload の再送は冪等、同じ ID の別 payload は409。旧 `{selection, stake}` 形式も互換用に受け付ける。`GET /api/performance/rank-comparison` は購入時に保存した rank 1 を使い、全券確定・rank 1 を含む複数選択 group を同じレース集合・同じ総賭け金で比較する。順位の根拠は `candidate_rank/count`, `predicted_at_at_bet`, `odds_captured_at`, `bet_group_id` に保存し、後から再推定しない。旧 bet は順位不明として同比較から除外する。`POST /api/models/:id/promote|rollback` はモデル管理、`POST /api/ingest/{venues,races,entries,results,payouts,odds,predictions,models,collection-runs}` は Python 等からの冪等同期。`POST /api/admin/settle` は認証付き精算操作。多くの読み取り API は `origin=sample|real|all` で出所を絞れる。実際の入出力契約は `apps/api/src/index.ts` と `packages/shared/src/types.ts` が根拠。

### 仮想購入履歴の結果待ち

`GET /api/bets` は購入時の情報を変更せず、未精算購入に限り `resultWaitReason` を返す。理由はレース状態・発走時刻、同じ出所の出走数と結果数（重複・出走外の結果も確認）、1着結果とその払戻、および精算状態から導く。区分は発走前、公式結果未取得、払戻未取得、結果収集失敗/一部失敗の記録あり、精算待ち、状況不明、中止、失格、欠場。失敗記録は当該レースの欠損原因を証明しない。結果収集の試行・成功時刻は、実データのボートで対象日と `mbrace-boat` ソースが一致する場合だけ返す（試行は開始、成功は完了時刻。未来時刻の記録は除外）。他の競技・サンプルには公式結果の収集状況を推定しない。サンプル購入は「サンプル（公式結果ではありません）」と明示し、公式結果待ちと混同しない。

## AI・データフロー

1. `ml/edgelab/collectors/` が公式ボートレース B/K ファイルを取得し、`parsers/` が正規化する。日次処理はローカル JSON store を再利用し、再実行できる自然キーでデータをまとめる。
2. `features/` は許可した数値特徴量だけを作る。`available_at <= predicted_at` と同日・未来情報の除外を検査する。結果／払戻などを特徴量に混入させないため、特徴量列は allowlist で制限される。
3. `ml/edgelab/models/train.py` は時系列で train / validation / test を分割して LightGBM を学習し、検証データで温度校正する。レース単位 bootstrap の出力ばらつきが `prob_std`。十分なデータがない場合は暗黙に代替モデルを使わず `untrained` とする。成果物は `ml/artifacts/`。
4. `ml/edgelab/predict.py` は確率と不確実性を出し、`ml/edgelab/sync.py` が 500 行以下のチャンクで ingest API へ送る。Worker は予測を再計算せず、`packages/shared/src/ev.ts` の規則に沿う評価・候補表示と仮想運用を行う。
5. 日次 Action の `python -m edgelab daily` は前日・当日の B/K 収集、当日の予測、両日の取得済み結果・払戻の同期を行い、その後に履歴 backfill と実データのフィードバック採点を行う。予測は認証付きレジストリで確認した active モデルだけを使い、candidateを稼働モデルの代わりにはしない。対応する artifact がない・後日情報の特徴列を持つ場合は推論を停止し、結果同期とフィードバックは継続する。
6. 週次 Action の `python -m edgelab learn` は新規完了レースの増分を確認し、別IDの候補モデルを再学習する。同じ時間順holdout上で比較できる安全な稼働モデルとの比較を記録し、`promotionEligible=false` の候補は画面・APIとも通常昇格を拒否する。holdoutは週次評価で再利用されるため、独立した最終的な利益の証明とはしない。候補モデルの本番昇格・ロールバックは人が画面/APIから行う。

初回ベースラインの検証は `python -m edgelab validate-baseline` が既存candidateの保存済みartifactと実データを再学習・再収集なしで評価する別経路。適格条件は時間分離・完全コホート・lane基準とのpaired race/date-cluster区間などで、認証済みモデルregistry snapshotとartifact identityにも結び付ける。適格でも通常の改善昇格とは別の明示的な人手承認が必要で、承認後も初期の仮想運用モデルに過ぎず、クリーンな稼働モデルとの改善、point-in-time情報到着、または正の期待値・利益の証拠ではない。

ボートの新規学習・推論入力は、生成したBファイル由来の事前特徴量に限定し、元の出走行から後日取得の展示・ST・気象を再混入させない。B情報の過去時点での公開時刻は記録されておらず、事前入手可能性は仮定である。旧v1は互換性検査で除外し、推論時には `boatFeatureSchemaVersion` と登録されたpickle SHA256をartifact実体と照合する。Workerの候補表示・自動/手動仮想購入・校正集計も安全なschema markerとSHA256のあるboatモデルの保存済み予測だけを使うため、旧v1予測はこれらに混入しない。既存の購入履歴は別途残り、実績の証明にはならない。`ml/edgelab/learning.py` の採点は、実データ・全艇の予測と結果・締切前時刻がそろうコホートを対象とする。オッズを用いた仮想リプレイと実際の仮想購入履歴の成績は区別する。詳細と不足条件は [LEARNING](LEARNING.md)、既存モデルの監査結果は [EV_AUDIT](EV_AUDIT.md) を参照。

Worker の単一 `* * * * *` Cron は、オッズ収集フラグが有効なら当日対象レースの公式単勝オッズを取得し、`scheduledTime` が10分境界なら open bet 精算、自動**仮想**購入、古いオッズ削除も行う。10分境界の判断は実行遅延の影響を避けるためイベントの予定時刻に基づく。オッズ収集は毎回、対象を読み出した後、重複防止ロックの取得より先にUTC日次の推定予約枠を確保する。上限を超える場合は取得せず、予約は日次同期・精算・他 Worker の書込を含まない。通常終了ではロックを解放し、異常終了時の残留ロックは5分で期限切れになる。収集失敗時も10分境界の精算等は継続する。予算上限時は取得頻度・15分前のカバーを保証しない。SPEC の10分ごとに全処理を行う記述とは差分があり、SPEC は変更していない。許諾・デプロイ済み設定はコードだけでは確認できない。

### 仮想バンクロールと bet の制御

- 初期値は `initial_bankroll=100000` 円、`unit_stake=100` 円。どちらも D1 の `settings` で管理される。
- 手動・自動とも単勝の仮想 bet のみ。手動はレースごとに最大6選択を1つの原子的な ticket group として記録し、stake は正の整数円（`unit_stake` の倍数制約なし）。自動は既定1候補、最大6候補まで設定でき、`auto_bet_race_budget`（初期値100円）を候補へ均等に整数円配分する。投票サイトや決済には接続しない。
- 新規 bet は購入時点のオッズ取得時刻・予測時刻と、当時の候補順位（有効な予測と鮮度内オッズがある候補を期待ROI降順、艇/馬番昇順で同率順序）を保存する。旧 bet は順位・グループ不明として比較対象から除く。`/performance/rank-comparison` は rank 1 を含む複数選択 group の全件確定レースだけを対象に、実際の複数 bet と rank 1 のみへ同額を配分した反実仮想を比較する。利益の証明ではない。
- 整数円 stake の仮想払戻は、`stake / 100 * 公式払戻` の1円未満を bet ごとに切り捨て、整数円で保存する。SPEC の `payout INT` は従来どおりだが、従来実装の stake 制約（`unit_stake` 倍数）は新しい手動 bet では適用しない。
- 自動購入は Worker の `ENABLE_AUTO_BET=true` または D1 `auto_bet_enabled=true` のどちらかで有効になる。最新予測のモデルが `active` で、オッズがあり、`min_expected_roi`（初期値 0.05）以上かつ `HIGH_EDGE` / `POSITIVE_EDGE` 判定の候補だけを対象とする。`max_prob_std`（初期値 0.05）を超える予測は edge 判定で除外される。週次学習で作られた `candidate` モデルは自動購入に使われない。
- 手動・自動の購入は、利用可能なactive予測と10分以内のオッズ、解析可能な未来の締切時刻を要求する。boatはさらに安全な特徴量markerと64桁artifact SHA256を持つactiveモデルに限定し、旧v1の既存予測を使わない。締切後・未来の予測やオッズを候補に使わず、異なるUTCオフセットはSQLiteの時刻変換で比較する。出走・予測・オッズ・結果の出所はレースと一致させる。これは収益保証ではなく、誤った時点の判断を防ぐ追加ガード。
- モデルingestはactive/retired行の状態・評価を上書きしない。古い番組表を再同期してもfinished/cancelledレースをscheduledに戻さない。
- 精算はレースと購入の出所が一致し、全出走の結果と全勝者の実単勝払戻がそろうまでopenを維持する。結果・払戻の別POSTや取り込み遅延だけで負けに確定しない。既に確定した過去の購入を自動で書き換える処理は追加していない。
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
- `.github/workflows/retrain.yml`: 毎週月曜 UTC `02:41`（JST 11:41）と手動実行。boat の候補学習と比較を行い、候補の `models` 行だけを同期する。
- 両workflowは学習state/cacheの競合を避ける共通concurrency groupを使う。`ml/data` と `ml/artifacts` をcacheで持ち越し、採点・学習レポートをActions artifactへ保存する。外部サービスのスケジュール実行は常時稼働や実行時刻を保証しない。
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

## 券種拡張（2026-10-10 開発中）

ユーザー依頼による拡張として、単勝とは別の `ticket_predictions` を追加し、ボート3連単の順序付き120組を扱う。これはSPECの単勝限定API・元の予測スキーマとの差分であり、SPECは書き換えていない。他券種は型に存在しても購入対応済みとはしない。

- 三連単は着順を学習した独立のランキングモデルから整合した確率分布を作る。単勝確率の積を使わない。時間分離holdout、trainだけで作る艇番順序基準、実際の取得時点のオッズで検証する。
- 候補は自動昇格しない。券種・artifact・独立検証証跡が一致したactiveモデルのみ仮想購入可能。未取得、未検証、確率集合不完全、標準偏差欠損、公式オッズの出所／組番／時刻不整合なら候補にしない。
- 単勝と三連単の候補を保守的期待収益率で比較する。自動購入は既存のレース予算と単勝の複数選択を保持し、三連単の保守的ROIが単勝を上回る場合に同じレース予算内で三連単1件を選ぶ。
- 結果と券種の払戻が整合しない場合はopenを保持する。同着・欠場・返還を含む三連単は現時点で対象外。取得時オッズと払戻換算オッズは区別する。
- 公式ページの実データ照合は [TICKET_DATA_AUDIT](TICKET_DATA_AUDIT.md) の1レースのみ。全履歴の公式一致、取得許諾、本番反映、利益は未証明。
- 本変更のリモートD1 migration、本番Workerデプロイ、新モデル昇格は未実施。既存単勝運用とは区別する。
- D1 変更は `0004_ticket_predictions_and_odds_evidence.sql`（購入時オッズ時刻は既存の `0007_ranked_multi_bets.sql` を利用） の追加 migration。三連単オッズ収集は `ENABLE_BOATRACE_TRIFECTA_ODDS_SCRAPE` が明示的に有効なときだけ Cron で動き、未設定／false が既定。単勝と共有する Worker fetch 試行上限49・最低3秒間隔を守る。取得は6艇120組が完全な非確定市場だけ保存し、source URL・取得時刻・本文 SHA-256・品質状態を記録する。これらは出所記録であり、署名や利用許諾の証明ではない。
- 自動購入は同じレース予算内で単勝の複数選択と三連単の保守的ROIを比較し、券種追加で露出を増やさない。モデル学習時刻は予測時刻より厳密に前であることを要求する。

## 会場混同の復旧ガード

共通B/Kパーサーは唐津/津の重複を避けるため長い場名を優先する。旧モデルは復旧済みの出所markerがないため稼働・昇格・rollbackから除外し、正確なartifact/クリーンな入力に基づく候補を別IDで人手検証する。`auto_bet_paused` はWorker有効フラグより優先する停止条件。migration 0006の永続隔離は表示・精算・校正・資金計算・再ingestに適用する。migration 0007 は bet に購入時点のグループ・順位・候補母数・予測/オッズ時刻を追加する。なお SPEC §3/§5 は単一 bet と `unit_stake` 倍数を記述しており、現実装の複数選択・正の整数円 stake と差分がある。払戻列は整数円 `INT` のまま、切り捨て規則を導入した。SPEC は変更していない。原本からの修復と、固定評価期間の候補検証・Actions artifact復旧の流れは [RECOVERY](RECOVERY.md) を参照。

三連単の収集も共有 D1 推定予約枠（UTC日ごと全Worker 20,000・オッズ10,000）の対象で、120組の書き込み増幅を予約できる対象数だけ取得する。枠が欠落・破損・枯渇している場合は外部fetchや収集用ロック更新より先に停止する。取得許諾は公式サイトオッズについてのユーザー申告に基づき、独立した許諾証明ではない。
