#!/usr/bin/env bash
# UI smoke tests: a real backend on a throwaway catalog, driven by Playwright.
#   one-time:  (cd tests/ui && npm install && npx playwright install chromium)
#   run:       tests/ui/run.sh
# Needs the app's .venv (./run.sh once). Nothing touches your real catalog,
# cache or trash: everything lives in a temp dir that is deleted afterwards.
set -euo pipefail
cd "$(dirname "$0")/../.."
PY="${PYTHON:-.venv/bin/python}"
TMP="$(mktemp -d)"
PORT="${MANTIPHY_TEST_PORT:-7899}"
trap 'kill "${PID:-0}" 2>/dev/null || true; rm -rf "$TMP"' EXIT
"$PY" tests/ui/fixtures.py "$TMP/photos"
MANTIPHY_DATA="$TMP/data" MANTIPHY_CACHE="$TMP/cache" MANTIPHY_PORT="$PORT" MANTIPHY_SIDECARS=0 \
  XDG_DATA_HOME="$TMP/xdg" "$PY" backend/server.py > "$TMP/server.log" 2>&1 &
PID=$!
for i in $(seq 1 60); do curl -s "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 0.25; done
curl -s -X POST "http://127.0.0.1:$PORT/api/import" -H 'content-type: application/json' -d "{\"path\":\"$TMP/photos\"}" >/dev/null
MANTIPHY_URL="http://127.0.0.1:$PORT" MANTIPHY_TMP="$TMP" node tests/ui/smoke.mjs || { echo "--- server log"; tail -40 "$TMP/server.log"; exit 1; }
