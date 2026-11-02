#!/usr/bin/env bash
# Captures the README screenshots from the public sample doc, in a fresh browser session so no other jobs show.
# Needs the app running (npm start) and Playwright CLI (npm i -g @playwright/cli).
set -euo pipefail

APP="${APP:-http://localhost:3000}"
SAMPLE="${SAMPLE_DOC_URL:-https://docs.google.com/document/d/1u9lP5RTnm3He3JDq1HMAjfFW_VLspGV-1lm6CZh4s50/edit}"
OUT="docs/screenshots"
PW="playwright-cli -s=docshots-readme"
mkdir -p "$OUT"

$PW open "$APP/#/" >/dev/null
$PW resize 1440 900 >/dev/null
# A fresh visitor: no cookie means no earlier jobs.
$PW cookie-clear >/dev/null
$PW localstorage-clear >/dev/null
$PW goto "$APP/#/" >/dev/null

# Start a job on the sample doc, the way a visitor would.
$PW fill "#link" "$SAMPLE" >/dev/null
# PRESET=warframe picks the Warframe arbitration preset (frame portraits and map names).
if [ "${PRESET:-plain}" = "warframe" ]; then
  $PW eval "() => [...document.querySelectorAll('input[name=preset]')][1].click()" >/dev/null
fi
$PW eval "() => document.querySelector('form.start button.primary').click()" >/dev/null

# Wait for the job to finish, asking the app's own API (the visitor's newest job).
job=""
for _ in $(seq 1 90); do
  state=$($PW eval "async () => { const r = await (await fetch('/api/runs')).json(); return r.length ? r[0].id + ':' + r[0].status : '' }" --raw 2>/dev/null | tr -d '"' || true)
  job="${state%%:*}"
  [ "${state##*:}" = "done" ] && break
  sleep 2
done
[ -n "$job" ] || { echo "no job started" >&2; exit 1; }
echo "job $job finished"

shot() { $PW goto "$APP/#/run/$job/$1" >/dev/null; $PW reload >/dev/null; sleep 3; $PW screenshot --filename="$OUT/$2.png" >/dev/null; echo "saved $OUT/$2.png"; }
shot report job-report
shot queue paste-queue
shot review review
$PW goto "$APP/#/" >/dev/null; sleep 2; $PW screenshot --filename="$OUT/new-job.png" >/dev/null; echo "saved $OUT/new-job.png"

$PW close >/dev/null
