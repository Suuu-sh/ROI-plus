# EdgeLab

競馬（JRA）とボートレースの **AI 予測・期待値分析・仮想運用** プラットフォーム。
実際の投票・購入機能はありません（仮想購入のみ）。費用 0 円（Cloudflare 無料枠 + ローカル / GitHub Actions の Python）で動かす前提です。

設計・作業時は [AGENTS.md](AGENTS.md) と [docs/SPEC.md](docs/SPEC.md) を確認してください。実装構成と開発・運用上の注意は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) にまとめています。

## 期待値の確認と自律学習

現時点の利益の根拠と限界は [期待値の監査](docs/EV_AUDIT.md)、自動フィードバックと候補再学習の運用は [自律学習](docs/LEARNING.md) を参照してください。モデル上の期待収益率と、実データの確定購入から得る収益実績は別です。

日次処理は予測と後日の結果を照合し、週次処理は新しい完了レースが十分に増えた場合に候補を再学習します。同じ未学習期間で比較できない・改善を確認できない候補は昇格不可として保存し、本番モデルを自動置換しません。レポートは GitHub Actions artifact に残します。

ネットワークを使わず、保存済み実データだけで評価するコマンド:

```sh
PYTHONPATH=ml ml/.venv/bin/python -m edgelab feedback
```

仮想購入はレース単位で最大6選択をまとめて記録でき、各 stake は正の整数円です（1円未満の払戻は券ごとに切り捨て）。購入時の候補順位を保存し、全券が確定した同じ比較対象レース・同額予算で「選択分」と「rank 1のみ」の仮想成績を比較できます。旧 bet は順位不明のため比較から除外します。これは利益の保証ではありません。仕様との差分と API 契約は [ARCHITECTURE](docs/ARCHITECTURE.md#仮想バンクロールと-bet-の制御) を参照してください。

旧 `boat-win-lgbm-v1` には後日情報が特徴量に混入する経路が確認されました。旧モデルの指標を利益の証明として扱わず、新しい安全な候補を別IDで評価します。互換性のない稼働モデルでは推論を停止し、結果収集・同期・フィードバックは継続します。

初回ベースラインの復旧は通常の候補昇格とは別経路です。既存候補を固定済みartifactと時間順holdout・lane基準で検証し、適格でも明示的な人手確認が必要です。これは初期の仮想運用ベースラインであり、安全な稼働 incumbent との改善比較、過去時点の情報到着証明、または正の期待値・利益の証明ではありません。ボート推論は安全な特徴量スキーマと登録済みartifact SHA256を要求し、Pythonでartifact実体との一致を確認します。Workerの候補表示・仮想購入・校正集計も、このスキーマmarkerとSHA256を持つモデルの保存済み予測だけを使い、旧v1の保存済み予測はこれらの判断に使いません。

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

推論は Workers 上では行わず、Python で予測した結果を `/api/ingest/*` 経由で D1 に反映します。

## セットアップ

前提：Node.js 20+、Python 3.11+、macOS の場合は `brew install libomp`（LightGBM 用）。

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

API Worker の日次 D1 書込は推定 20,000 unit、うちオッズ収集 10,000 unit の上限で保護します。認証付き `GET /api/ingest/write-budget` で状態を確認してください。予算が欠落・破損している場合は fail-closed となり、初回 seed には人手による操作が必要です（詳細は [アーキテクチャ](docs/ARCHITECTURE.md#d1-日次書込予算)）。この Worker 内の上限であり、他アプリを含む Cloudflare アカウント全体の quota 残量は保証しません。

## データソースと制約

| 競技 | ソース | 状態 |
|---|---|---|
| ボートレース | 公式ダウンロード（番組表 B / 競走成績 K） | 採用。過去データ・出走表・結果・払戻・展示タイム・気象を取得 |
| ボートレース | 公式サイトの単勝オッズ | `apps/api/wrangler.toml` の取得フラグが有効な環境では Worker が収集します。毎分トリガー、締切まで15分以内、JST当日、最大30対象、取得間隔3秒以上・失敗時1回リトライです。同じトリガーの10分境界では精算・自動仮想購入・古いオッズ削除も行います。オッズ収集器内の推定予約上限はUTC日ごとに10,000行で、使い切ると停止します。日次同期・精算・他 Worker の書込は別で、この上限は Cloudflare アカウント全体の残量ではなく、頻度や15分前取得の完全な保証でもありません。README上の仕様とは異なる実装があり、許諾・本番稼働状態もコードからは確認できません。オッズが無い買い目は `INSUFFICIENT DATA` |
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

三連単の収集も共有 D1 推定予約枠（UTC日ごと全Worker 20,000・オッズ10,000）の対象で、120組の書き込み増幅を予約できる対象数だけ取得する。枠が欠落・破損・枯渇している場合は外部fetchや収集用ロック更新より先に停止する。取得許諾は公式サイトオッズについてのユーザー申告に基づき、独立した許諾証明ではない。
