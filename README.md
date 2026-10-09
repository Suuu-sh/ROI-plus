# EdgeLab

競馬（JRA）とボートレースの **AI 予測・期待値分析・仮想運用** プラットフォーム。
実際の投票・購入機能はありません（仮想購入のみ）。費用 0 円（Cloudflare 無料枠 + ローカル / GitHub Actions の Python）で動かす前提です。

設計の正本は [docs/SPEC.md](docs/SPEC.md)。

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

```bash
cp apps/api/.dev.vars.example apps/api/.dev.vars
```

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
EDGELAB_API_URL=http://127.0.0.1:8787 INGEST_TOKEN=<.dev.vars の値> PYTHONPATH=ml ml/.venv/bin/python -m edgelab sync
```

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
- D1: `roi-plus`。本番トークンは `/Users/yota/Projects/Secrets/ROI+/production.env`

## デプロイ手順（参考）

```bash
npx wrangler d1 create edgelab
```

作成された `database_id` を `apps/api/wrangler.toml` に設定し、`npx wrangler d1 migrations apply edgelab --remote`、`npx wrangler secret put INGEST_TOKEN`、`npm -w apps/api run deploy`。Web は Cloudflare Pages に `apps/web` をビルドして配置します。GitHub Actions（`.github/workflows/collect.yml`）は secrets `EDGELAB_API_URL` と `INGEST_TOKEN` を設定すると毎日収集・推論・同期します。

## データソースと制約

| 競技 | ソース | 状態 |
|---|---|---|
| ボートレース | 公式ダウンロード（番組表 B / 競走成績 K） | 採用。過去データ・出走表・結果・払戻・展示タイム・気象を取得 |
| ボートレース | 公式サイトのオッズ | **既定無効**。自動取得の許諾を確認できていないため。オッズが無い買い目は `INSUFFICIENT DATA` |
| 競馬 | netkeiba（keiba-scraping） | 不採用。利用規約がスクレイピングを禁止 |
| 競馬 | JRA-VAN | 不採用。有料 |
| 競馬 | ユーザー提供 CSV | 採用。`ml/edgelab/importers/horse_csv.py` で取り込み |

- 取得できない値は補完せず欠損（NULL）として扱います。予測値・オッズは捏造しません。
- 予測時点以降に判明する情報（展示タイム等）は利用可能時刻で管理し、過去の予測に混入させません。
- モデルの自動昇格は無効です。Log Loss・Brier が改善し ECE が悪化しない場合のみ「昇格候補」となり、モデル管理画面から手動で昇格・ロールバックします。
- 期待収益率 = 予測勝率 × オッズ − 1。判定は不確実性（予測の標準偏差）を差し引いた保守的な値で行います。
