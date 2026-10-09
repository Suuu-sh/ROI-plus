#!/bin/zsh
# 締切前25分以内のレースの単勝オッズを取得し、予測と合わせて本番へ同期する（10分ごと）。
set -eu
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"
set -a; . "/Users/yota/Projects/Secrets/ROI+/production.env"; set +a
export EDGELAB_API_URL="$API_URL" PYTHONPATH=ml ENABLE_BOATRACE_ODDS_SCRAPE=true
mkdir -p ml/data/logs
{ date; ml/.venv/bin/python -m edgelab live --date "$(TZ=Asia/Tokyo date +%F)" --window-min 25 --max-requests 30; } >> ml/data/logs/live-odds.log 2>&1
