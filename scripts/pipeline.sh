#!/bin/bash
# X-Capital Flow — Real-time data pipeline
# Runs the live snapshot ingest, logs output with timestamps.
#
# CRON SETUP (runs every 5 min on weekdays 9am–4pm IST = 3:30am–10:30am UTC):
#   crontab -e
#   */5 3-10 * * 1-5  /path/to/X-Capital\ Flow/scripts/pipeline.sh >> /tmp/xcapital_pipeline.log 2>&1
#
# Or for a simple every-15-min all-day run:
#   */15 * * * *  /path/to/X-Capital\ Flow/scripts/pipeline.sh >> /tmp/xcapital_pipeline.log 2>&1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_PREFIX="[$(date '+%Y-%m-%d %H:%M:%S IST')]"

echo ""
echo "$LOG_PREFIX ═══ X-Capital Flow Pipeline ═══"
cd "$PROJECT_DIR" || exit 1

/opt/homebrew/opt/python@3.14/Frameworks/Python.framework/Versions/3.14/bin/python3 scripts/fetch_prices.py --live --no-cache

echo "$LOG_PREFIX ✅ Done"
