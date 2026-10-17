# EdgeLab

競馬（JRA）とボートレースの **AI 予測・期待値分析・仮想運用** プラットフォーム。
実際の投票・購入機能はありません（仮想購入のみ）。Worker は Cloudflare Workers Paid 環境を前提とし、Containers は追加しません。ローカル / GitHub Actions の Python 処理も一部残ります。

設計・作業時は [AGENTS.md](AGENTS.md) と [docs/SPEC.md](docs/SPEC.md) を確認してください。実装構成と開発・運用上の注意は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) にまとめています。

## iPhone のホーム画面から使う

Safari で ROI+ を開き、共有ボタンから「ホーム画面に追加」を選び、「Webアプリとして開く」を有効にして追加します。以後はホーム画面のアイコンから起動してください。ホーム画面の Web アプリ起動時はブラウザーの URL・操作バーが表示されません。通常の Safari タブやアプリ内ブラウザーのバーを隠す設定ではありません。データ取得にはネット接続が必要です（オフライン対応はありません）。App Store 配布のネイティブアプリではありません。

## 期待値の確認と自律学習

現時点の利益の根拠と限界は [期待値の監査](docs/EV_AUDIT.md)、自動フィードバックと候補再学習の運用は [自律学習](docs/LEARNING.md) を参照してください。モデル上の期待収益率と、実データの確定購入から得る収益実績は別です。 実験三連単の購入時確率と実的中の比較、および隔離校正候補の制約は [2026-10-17 校正監査](docs/reports/experimental-trifecta-calibration-2026-10-17.md) と [校正候補](docs/reports/2026-10-17-trifecta-calibration-candidate.md) を参照してください。 月次損失許容額1万円・低確率券除外の隔離比較は [月次購入ルール候補](docs/reports/monthly-strategy-2026-10-17.md) を参照してください（部分月の探索的評価、未採用）。

日次処理は予測と後日の結果を照合し、週次処理は新しい完了レースが十分に増えた場合に候補を再学習します。同じ未学習期間で比較できない・改善を確認できない候補は昇格不可として保存し、本番モデルを自動置換しません。レポートは GitHub Actions artifact に残します。

ネットワークを使わず、保存済み実データだけで評価するコマンド:

```sh
PYTHONPATH=ml ml/.venv/bin/python -m edgelab feedback
```

仮想購入はレース単位で最大6選択をまとめて記録でき、各 stake は正の整数円です（1円未満の払戻は券ごとに切り捨て）。購入時の候補順位を保存し、全券が確定した同じ比較対象レース・同額予算で「選択分」と「rank 1のみ」の仮想成績を比較できます。旧 bet は順位不明のため比較から除外します。これは利益の保証ではありません。仕様との差分と API 契約は [ARCHITECTURE](docs/ARCHITECTURE.md#仮想バンクロールと-bet-の制御) を参照してください。

旧 `boat-win-lgbm-v1` には後日情報が特徴量に混入する経路が確認されました。旧モデルの指標を利益の証明として扱わず、新しい安全な候補を別IDで評価します。互換性のない稼働モデルでは推論を停止し、結果収集・同期・フィードバックは継続します。

初回ベースラインの復旧は通常の候補昇格とは別経路です。既存候補を固定済みartifactと時間順holdout・lane基準で検証し、適格でも明示的な人手確認が必要です。これは初期の仮想運用ベースラインであり、安全な稼働 incumbent との改善比較、過去時点の情報到着証明、または正の期待値・利益の証明ではありません。ボート推論は安全な特徴量スキーマと登録済みartifact SHA256を要求し、Pythonでartifact実体との一致を確認します。Workerの候補表示・仮想購入・校正集計も、このスキーマmarkerとSHA256を持つモデルの保存済み予測だけを使い、旧v1の保存済み予測はこれらの判断に使いません。

固定BASE三連単モデルのT-60入力・120確率・締切前120オッズは、実データの取得時刻を保持してprivate R2へ不変保存し、週次の [3か月候補学習](docs/ARCHITECTURE.md#固定baseモデルのr2観測アーカイブと3か月候補学習) はJST暦月のrolling windowで読み取ります。将来の実データだけを積み上げるため、初期は学習可能な3か月分がなく `insufficient_data` となります。これは隔離candidate / 検証reportのみで、通常モデルregistry・live推論・昇格は変更しません。R2欠損・結果ラベル不足・時刻証跡不備を補完せず、全件coverageや利益を主張しません。

## 構成

| パス | 内容 |
|---|---|
| `apps/web` | React + TypeScript + Vite + Tailwind のダッシュボード |
| `apps/api` | Cloudflare Workers（Hono）+ D1 の REST API・Cron（精算・自動仮想購入・古いオッズ削除） |
| `packages/shared` | 型定義・期待値計算・判定・評価指標（web / api 共通） |
| `db/migrations` | D1 スキーマ |
| `db/seed` | サンプルデータ生成（`data_origin='sample'`） |
| `ml/` | Python：公式データ収集・パース・特徴量・LightGBM 学習・校正・推論・D1 同期 |
| `data/fixtures` | テスト用の合成ボートレースデータ（実データを含まない） |
| `data/private_fixtures` | ローカル専用の公式データ置き場（Git 管理外） |

実験三連単の予測は、登録済みモデルを照合して Worker 内で生成します（実レースfixtureでPython入力・確率を比較）。通常モデルの推論・稼働モデル学習は既存の Python 処理を引き続き使います。`ENABLE_NATIVE_DAILY_PIPELINE=true` の場合、別の5分 Worker Cron が公式 B/K を1ファイルずつ D1/R2 に同期し、大きな同期はR2 cursorから継続します。08:00 JST の B readiness deadline 後も当日内は bounded retry します。同期状況は `/api/collection/status` の `nativeDailyStatus` で確認できます。デプロイ済みの private Worker learner (`FORECAST_LEARNER`) は、実験候補 (`/learn`) と通常モデル候補 (`/learn/normal`) を別 invocation で生成します。通常候補はB当日・K前日の同期成功後だけ開始し、結果を `/api/collection/status` の `nativeNormalLearning` に報告します。両者とも隔離 candidate の生成だけで、registry登録・昇格・稼働モデル更新は行いません。通常候補は NumPy logistic であり、既存 LightGBM incumbent の置換・同等性を意味しません。旧 `retrain`・実験学習 workflow は手動実行のみです。通常予測を含む既存Actions日次処理と、別仕様の研究用候補workflowは残していますが、このB/K同期・日次候補学習の起動には依存しません。

## セットアップ

前提：Node.js 22+、Python 3.11+、macOS の場合は `brew install libomp`（LightGBM 用）。

```bash
npm install
```

```bash
python3 -m venv ml/.venv && ml/.venv/bin/pip install pandas numpy scikit-learn lightgbm lhafile pytest
```

ローカル ingest を使う場合は、Wrangler のローカル環境に `INGEST_TOKEN` を安全に設定してください（値は共有・記録しない）。

### ローカル起動

```bash
npm run dev
```

ローカル D1 をマイグレーション＋サンプル投入してから、API（:8787）と Web（:5180）を起動します。ブラウザで http://localhost:5180 を開きます。
画面右上の「すべて / 実データ / サンプル」でデータの出所を切り替えられます。

サンプルデータは生成日を「今日」として作られます。日付が変わったら再生成してください。

```bash
node db/seed/generate.mjs && npm run db:reset
```

### 実データ（ボートレース公式）の取り込み

```bash
PYTHONPATH=ml ml/.venv/bin/python -m edgelab backfill --from 2026-07-01 --to 2026-10-08
```

```bash
PYTHONPATH=ml ml/.venv/bin/python -m edgelab train --sport boat
```

```bash
EDGELAB_API_URL=http://127.0.0.1:8787 PYTHONPATH=ml ml/.venv/bin/python -m edgelab sync
```

実行前に `INGEST_TOKEN` をプロセス環境へ安全に設定してください。値をコマンド引数やシェル履歴に含めないでください。

詳細は [ml/README.md](ml/README.md)。

## テスト

```bash
npm test
```

```bash
ml/.venv/bin/python -m pytest ml/tests -q
```

## 本番環境（ROI+）

- Web: https://roi-plus.suuu-sh.workers.dev （Worker `roi-plus`、`apps/web` で `npm run build && npx wrangler deploy`）
- API: https://roi-plus-api.suuu-sh.workers.dev （Worker `roi-plus-api`、`apps/api` で `npx wrangler deploy`）
- D1: `roi-plus`

## デプロイ

既存の Cloudflare Workers 構成・開発／テスト／デプロイ手順、Actions のスケジュールと必要な Secret 名は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) を参照してください。記載のデプロイやリモート D1 操作は本番変更になるため、明示的な依頼なしに実行しないでください。秘密値やローカルの保管場所はリポジトリに記載しません。

GitHub Actions の `.github/workflows/deploy-workers.yml` は、`main` への push に `.github/workflows/deploy-workers.yml`、`apps/api/**`、`apps/web/**`、`packages/shared/**`、`package.json`、`package-lock.json`、`db/migrations/**`、`scripts/check-d1-migrations-ready.mjs`、`scripts/check-d1-migrations-ready.test.mjs` のいずれかの変更が含まれる場合に起動します。ドキュメントのみの変更では起動しません。

ジョブは gate の fixture tests、workspace typecheck・tests、API Worker の dry-run、Web asset build を終えてから、D1 の `d1_migrations` に対する最大100件の read-only query でリポジトリ内 migration と適用 ledger の一致を確認します。不一致、未適用 migration、ledger の欠落、query エラーは Worker の deploy 前に fail closed します。0010 と 0011 を含む D1 migration は workflow では適用しないため、コードを取り込む前に別途レビュー済みの migration 作業と schema readiness が必要です。

schema gate 通過後に API Worker を deploy し、公開 `/api/health` の HTTP status を確認してから、事前 build 済み Web Worker を deploy します。health check 失敗時は Web deploy を止めますが、API deploy の rollback は行いません。workflow は既存の `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets を使い、手動 dispatch trigger はありません。
API Worker のアプリ内 D1 推定書込予約は無効です。認証付き `GET /api/ingest/write-budget` は `state: disabled` として予約残量を表示しません。これは Cloudflare D1 provider quota や課金設定を変更せず、利用枠の残量も保証しません。履歴ガード・対象/fetch上限・競合ロック・冪等性・atomic batch は維持します（詳細は [アーキテクチャ](docs/ARCHITECTURE.md#d1-書込予約状態)）。

## データソースと制約

| 競技 | ソース | 状態 |
|---|---|---|
| ボートレース | 公式ダウンロード（番組表 B / 競走成績 K） | 採用。過去データ・出走表・結果・払戻・展示タイム・気象を取得 |
| ボートレース | 公式サイトの単勝オッズ | `apps/api/wrangler.toml` の取得フラグが有効な環境では Worker が収集します。毎分トリガー、締切まで15分以内、JST当日、最大30対象、取得間隔3秒以上・失敗時1回リトライです。同じトリガーの10分境界では精算・自動仮想購入・古いオッズ削除も行います。アプリ内の日次推定書込予約による停止は無効です。毎分対象数・Cron試行数・fetch間隔の上限は維持しますが、Cloudflare D1 provider quotaや課金枠の残量は計測・保証しません。README上の仕様とは異なる実装があり、許諾・本番稼働状態もコードからは確認できません。オッズが無い買い目は `INSUFFICIENT DATA` |
| 競馬 | netkeiba（keiba-scraping） | 不採用。利用規約がスクレイピングを禁止 |
| 競馬 | JRA-VAN | 不採用。有料 |
| 競馬 | ユーザー提供 CSV | 採用。`ml/edgelab/importers/horse_csv.py` で取り込み |

- 取得できない値は補完せず欠損（NULL）として扱います。予測値・オッズは捏造しません。
- 予測時点以降に判明する情報（展示タイム等）は利用可能時刻で管理し、過去の予測に混入させません。
- モデルの自動昇格は無効です。Log Loss・Brier が改善し ECE が悪化しない場合のみ「昇格候補」となり、モデル管理画面から手動で昇格・ロールバックします。
- 期待収益率 = 予測勝率 × オッズ − 1。判定は不確実性（予測の標準偏差）を差し引いた保守的な値で行います。

三連単は単勝とは別の完全な組番確率・モデル・オッズ証跡がそろうまで購入対象になりません。専用オッズ収集フラグ `ENABLE_BOATRACE_TRIFECTA_ODDS_SCRAPE` は未設定／false が既定で、明示有効時も共有 fetch 上限・取得間隔・完全な非確定120組の条件を適用します。スキーマ追加は `0004_ticket_predictions_and_odds_evidence.sql`（購入時オッズ時刻は既存の `0007_ranked_multi_bets.sql` を利用） です。適用・本番有効化は別途明示確認が必要です。

## 券種拡張の検証状態

三連単の候補学習・公式120組オッズの厳格パース・券種別の仮想購入基盤を追加した開発段階です。型で列挙されるすべての券種が運用可能という意味ではありません。新モデルは候補のまま、利益検証に必要な締切前オッズがない場合はROIを出しません。公式一致確認の範囲と限界は [データ照合記録](docs/TICKET_DATA_AUDIT.md)、モデルCLIは [MLガイド](ml/README.md) を参照してください。本番反映・三連単の稼働承認は別途必要です。

会場データの混同に対する停止・原本再構築・クリーンな単勝候補の検証・手動再開は [復旧手順](docs/RECOVERY.md) を参照してください。修正モデルでも正の期待値・利益を保証しません。

三連単の収集は既存の per-invocation fetch 上限・対象件数制限を守ります。アプリ内の日次推定書込予約による停止は無効ですが、Cloudflare D1 provider quotaや課金枠の残量は計測・保証しません。取得許諾は公式サイトオッズについてのユーザー申告に基づき、独立した許諾証明ではない。
