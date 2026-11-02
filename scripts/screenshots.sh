#!/usr/bin/env bash
# Captures the README screenshots from the public sample doc, in a fresh browser session so no other jobs show.
# Needs the app running (npm start) and Playwright CLI (npm i -g @playwright/cli).
set -euo pipefail

APP="${APP:-http://localhost:3000}"
SAMPLE="${SAMPLE_DOC_URL:-https://docs.google.com/document/d/1iBJmpxa9yOmNk_6sU9aayQzHc-r31p3N7Q5RCfVPBXY/edit}"
OUT="docs/screenshots"
PW="playwright-cli -s=docshots-readme"
mkdir -p "$OUT"

$PW open "$APP/#/" >/dev/null
$PW resize 1440 900 >/dev/null
$PW delete-data >/dev/null
$PW goto "$APP/#/" >/dev/null

# Start a job on the sample doc, the way a visitor would.
$PW fill "#link" "$SAMPLE" >/dev/null
$PW eval "() => document.querySelector('form.start button.primary').click()" >/dev/null

# Wait for the job to finish (the report's primary action appears when it has).
for _ in $(seq 1 60); do
  done=$($PW eval "() => !!document.querySelector('a.button.primary[href*=\"/queue\"]')" --raw 2>/dev/null || echo false)
  [ "$done" = "true" ] && break
  sleep 2
done
job=$($PW eval "() => location.hash.match(/run\\/(\\d+)/)[1]" --raw)

shot() { $PW goto "$APP/#/run/$job/$1" >/dev/null; sleep 2; $PW screenshot --filename="$OUT/$2.png" >/dev/null; echo "saved $OUT/$2.png"; }
shot report job-report
shot queue paste-queue
shot review review
$PW goto "$APP/#/" >/dev/null; sleep 2; $PW screenshot --filename="$OUT/new-job.png" >/dev/null; echo "saved $OUT/new-job.png"

$PW close >/dev/null
