# アーキテクチャと作業ガイド

この文書はリポジトリのコード・設定から確認できる構成を説明する。製品の目標と不変条件は [SPEC](SPEC.md)、実装の根拠は本文中に示したコード／設定を参照する。仕様と実装が異なる場合はどちらかを黙って正本扱いせず、差分を報告する。Cloudflare の管理画面、GitHub の Secret 設定、実行中環境の状態はこのリポジトリからは確定できない。

## 目標と現状の区別

| 項目 | 製品設計・目標 | リポジトリで確認できる実装 |
|---|---|---|
| 対象 | 競馬（JRA）とボートレース | 日次 Actions、公式データ収集、Worker Cron はボート中心。競馬はユーザー提供 CSV の取込・特徴量コードがあるが、JRA 自動収集はない。 |
| 予測 | 出典のあるデータを用いた AI 予測 | Python / LightGBM が学習・推論を行い、Worker はモデルを実行しない。アプリコードに LLM / GPT API 呼び出しは見当たらない。毎週の自動学習対象は boat。 |
| 購入 | 仮想運用のみ | `POST /api/bets` と Cron の自動購入は D1 の仮想 bet 記録のみ。投票・決済連携はない。Primary T-60 自動運用は実データの三連単 (`trifecta`) だけを評価する。 |
| オッズ | 取得許諾・頻度の制約を守る | Worker に公式単勝オッズ収集器がある。毎分トリガーは締切まで15分以内・JST当日の実データを対象にし、直近50秒の取得を除外、最大30レース・各対象1回リトライ・取得間隔3秒以上・1回最大49 fetch 試行。空対象ならDBへ書き込まない。`settings.roi_d1_write_budget_utc` の推定共有予約上限は20,000 unit/UTC日、オッズ専用内数は4,000 unit/日である。日次同期・精算・他 Worker の書込は別であり、これはアカウント全体のD1残量を読み取るものではなく、実際の行書込数とも一致せず、対象カバレッジは保証しない。10分トリガーは精算・自動仮想購入・古いオッズ削除のみを行う。SPEC の単一Cron記述・25分以内・10分鮮度とは差分があり、SPEC は変更していない。`apps/api/wrangler.toml` のフラグ値は設定情報であり、デプロイ済み状態や許諾を意味しない。 |
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

- API Worker は `settings.roi_d1_write_budget_utc` の UTC 日別カウンターで、この Worker の推定予約を通常合計20,000 unit/日以下に抑える。うち16,000 unitを当日・前日予測/結果、open betの精算入力、精算、仮想購入、手動モデル操作など essential 用に保護し、オッズ・cleanup・collection log・候補モデルなど optional work は合計4,000 unit/日までに制限する。オッズは optional 内数として最大4,000 unit/日。既知の当日台帳に限り、認証済みの明示操作 `POST /api/ingest/write-budget/allowance` で一度だけ、そのUTC日だけ合計30,000（essential 24,000 / optional 6,000、オッズ内数6,000）へ拡張できる。日付・確認フラグ・上限値は固定allowlistで検証し、既存予約を保持したうえでallowance適用のCASに2 essential unitを計上する。日付ロールオーバー後は通常上限へ戻る。これはCloudflareアカウント全体や他アプリのD1 quotaを計測・予約する仕組みではなく、実際の行書込数とも一致せず、残り実quotaは保証しない。移行・管理画面などWorker外の書込も対象外。
- 予約はレコードと索引数から保守的に見積もり、CASは単一のD1 `UPDATE ... WHERE value=?` で原子的に行う。再試行・途中失敗・CAS競合の予約は返却しない。既存形式の当日カウンターはリセットせず、category値がない場合は `min(4,000, reserved)` を optional に保守計上する（従来の19,946予約なら残り54のまま、optionalは停止）。カウンター欠落・破損は fail-closed、quota 増額や自動 seed はしない。
- `/api/ingest/*` は自然キーの既存行を索引検索し、NULL 安全な比較で変更がない場合は SQL を発行しない。上流の合成 `id`、同一内容の再送、race のみ変化した `updated_at` は更新根拠にしない。入力は最大500行/リクエスト。任意のクライアント分類は受け付けず、race日付はDB上の値（新規raceのみソースpayload値）で分類する。昨日より古い履歴 ingest/backfill は、open betに必要なrace metadata/entries/results/payoutsを除き409 `historical_ingest_disabled` で拒否する。将来レースは受付可能だがoptional枠を使う。当日・前日の有効active-model予測はessential、候補予測・オッズ・collection logなどはoptional枠を使う。必要予約は複数枠を単一CASで確保し、できない場合は HTTP 429 と `d1_write_budget_exhausted` を返す。
- オッズ収集、精算、auto/manual bet、古いオッズ削除、モデル昇格・rollback も同じ予約を通る。精算等 essential は保護枠を使い、オッズと古いオッズ削除はoptional枠のみ使う。settlement はオッズ収集エラーと独立して動くが、共有・essential予算が不明または尽きた場合は書込みを止める。
- 認証付き `GET /api