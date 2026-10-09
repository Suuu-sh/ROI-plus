#!/bin/zsh
# 本番 D1 へ過去データを1日の書き込み上限内で分割投入する（毎日実行）。
set -eu
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"
set -a; . "/Users/yota/Projects/Secrets/ROI+/production.env"; set +a
export EDGELAB_API_URL="$API_URL" PYTHONPATH=ml
mkdir -p ml/data/logs
{
  date
  ml/.venv/bin/python -m edgelab backfill-sync --since 2026-07-01 --until 2026-09-30 --budget 80000
} >> ml/data/logs/backfill-sync.log 2>&1
