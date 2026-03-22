#!/bin/bash
# Quick API functionality test. Run with: ./test_api.sh [base_url]
# Default: http://127.0.0.1:8080
BASE="${1:-http://127.0.0.1:8080}"
PASS=0
FAIL=0

test_ok() {
  if [ "$1" = "ok" ]; then
    echo "  ✓ $2"
    PASS=$((PASS+1))
  else
    echo "  ✗ $2"
    FAIL=$((FAIL+1))
  fi
}

echo "Testing $BASE"
echo ""

# Health
R=$(curl -s "$BASE/health")
[[ "$R" == *'"ok": true'* || "$R" == *'"ok":true'* ]] && test_ok "ok" "GET /health" || test_ok "fail" "GET /health"

# Config
R=$(curl -s "$BASE/api/config")
[[ "$R" == *'"location_range_options"'* ]] && test_ok "ok" "GET /api/config" || test_ok "fail" "GET /api/config"

# Create session
R=$(curl -s -X POST "$BASE/api/live-session" -H "Content-Type: application/json" \
  -d '{"display_name":"TestHost","restaurants":[],"chatState":{"history":[],"location":null,"location_range_miles":10,"stage_index":0,"readiness_score":0,"recommendations_started":false,"last_place_ids":[],"last_place_names":[],"preferences":{}}}')
CODE=$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('code',''))" 2>/dev/null || echo "")
[[ -n "$CODE" ]] && test_ok "ok" "POST /api/live-session (code: $CODE)" || test_ok "fail" "POST /api/live-session"

# Get session
if [[ -n "$CODE" ]]; then
  R=$(curl -s "$BASE/api/live-session/$CODE")
  [[ "$R" == *'"creatorUid"'* ]] && test_ok "ok" "GET /api/live-session/$CODE" || test_ok "fail" "GET /api/live-session/$CODE"

  # Join session
  R=$(curl -s -X POST "$BASE/api/live-session/$CODE/join" -H "Content-Type: application/json" -d '{"display_name":"Joiner"}')
  [[ "$R" == *'"ok": true'* || "$R" == *'"ok":true'* ]] && test_ok "ok" "POST /api/live-session/$CODE/join" || test_ok "fail" "POST /api/live-session/$CODE/join"
fi

# Main page
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/")
[[ "$HTTP" = "200" ]] && test_ok "ok" "GET / (main page)" || test_ok "fail" "GET / (main page)"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
