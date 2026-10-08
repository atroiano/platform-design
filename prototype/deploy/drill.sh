#!/usr/bin/env bash
# End-to-end blue-green rehearsal (SHARED-0010), in its OWN Compose project,
# ports, volume, and state, so it cannot touch an installation running from
# this directory. It installs one release, keeps payments flowing, brings up
# the next release beside it, cuts over, rolls back, cuts over again, retires
# the old color, and then checks that no request failed and that no money or
# history went astray. It also proves the refusals: the preview port is
# read-only, and a release two steps ahead may not strand the live one.
# KEEP=1 leaves the rehearsal stack running afterward.
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=hivear-drill
export HIVEAR_HTTP_PORT="${DRILL_HTTP_PORT:-18580}"
export HIVEAR_HTTPS_PORT="${DRILL_HTTPS_PORT:-18543}"
export HIVEAR_PREVIEW_PORT="${DRILL_PREVIEW_PORT:-18581}"
export HIVEAR_STATE_FILE=deploy/.drill/state.env
export HIVEAR_PROXY_DIR=./deploy/.drill/proxy

BG=deploy/bluegreen.sh
KEY="X-API-Key: ${HIVEAR_DEV_API_KEY:-local-evaluation-only}"
JSON="Content-Type: application/json"
LIVE="http://localhost:$HIVEAR_HTTP_PORT/api/v1"
PREVIEW="http://localhost:$HIVEAR_PREVIEW_PORT/api/v1"
WORK="$(mktemp -d)"
OPENING=5000000

step() { printf '\n######## %s\n' "$*"; }
field() { python3 -c "import sys, json; print(json.load(sys.stdin)['$1'])"; }
expect() { [ "$1" = "$2" ] || { echo "FAILED: $3: expected $2, got $1"; exit 1; }; echo "ok: $3 = $1"; }
refused() { if "$@" > "$WORK/refusal" 2>&1; then echo "FAILED: should have been refused: $*"; exit 1; fi; echo "ok: refused: $(grep -m1 -E 'ERROR|CommandError' "$WORK/refusal" | cut -c1-150)"; }
dc() { docker compose --env-file "$HIVEAR_STATE_FILE" "$@"; }
all_down() { docker compose --profile blue --profile green --profile tools down -v --remove-orphans > /dev/null 2>&1 || true; }
# payment <base url> [extra curl arguments]: send a one-unit payment, print the status.
payment() {
    local base="$1"; shift
    curl -s -o /dev/null -w '%{http_code}' "$@" -H "$KEY" -H "$JSON" "$base/commands/post-payment" \
        -d "{\"account_pks\":[\"$ACCOUNT\"],\"amount_minor_units\":1,\"currency_code\":\"USD\"}"
}
SITE="http://localhost:$HIVEAR_HTTP_PORT"

step "A rehearsal stack of its own (project $COMPOSE_PROJECT_NAME), and three releases built from this tree"
all_down
rm -rf deploy/.drill
# 0.2.0 is this tree. 0.3.0 is this tree plus one migration that adds a
# column, so that a real schema change crosses the cutover. 0.5.0 is two
# releases beyond that, for the jump that must be refused.
docker build -q --build-arg RELEASE=0.2.0 -t hivear-draft:0.2.0 . > /dev/null
docker build -q --build-arg RELEASE=0.3.0 -t hivear-draft:0.3.0-base . > /dev/null
docker build -q --build-arg BASE=hivear-draft:0.3.0-base -t hivear-draft:0.3.0 deploy/drill-next-release > /dev/null
docker build -q --build-arg RELEASE=0.5.0 -t hivear-draft:0.5.0-base . > /dev/null
docker build -q --build-arg BASE=hivear-draft:0.5.0-base -t hivear-draft:0.5.0 deploy/drill-next-release > /dev/null

step "Install release 0.2.0 as blue"
$BG init hivear-draft:0.2.0
dc exec -T app_blue python manage.py seed_demo
expect "$(dc exec -T app_blue python manage.py shell -c "from django.db import connection as c; x=c.cursor(); x.execute('select current_user'); print(x.fetchone()[0])" | tail -1)" hivear_app "application database user"
ACCOUNT="$(curl -fsS -H "$KEY" -H "$JSON" "$LIVE/commands/place-account" -d "{\"client_account_number\":\"DRILL-1\",\"debt_type\":\"personal_loan\",\"contract_type\":\"third_party_contingency\",\"currency_code\":\"USD\",\"list_date\":\"2026-02-01\",\"itemization_date\":\"2025-12-31\",\"opening_balances\":{\"principal\":$OPENING}}" | field account_pk)"
echo "account $ACCOUNT"
refused $BG init hivear-draft:0.2.0
refused $BG cutover
refused $BG rollback

step "Traffic: a payment and a health read against the live port, continuously"
(
    while [ ! -f "$WORK/stop" ]; do
        payment "$LIVE" >> "$WORK/payments" || true; echo >> "$WORK/payments"
        curl -s "$LIVE/health" | python3 -c "import sys, json; d = json.load(sys.stdin); print(d['color'], d['release'])" >> "$WORK/served" 2>/dev/null || echo "failed" >> "$WORK/served"
    done
) &
LOAD=$!
trap 'touch "$WORK/stop"; wait $LOAD 2>/dev/null || true; [ "${KEEP:-0}" = 1 ] || { all_down; rm -rf deploy/.drill; }' EXIT
sleep 3

step "A release two steps ahead would strand the live one, and is refused before anything changes"
refused $BG deploy hivear-draft:0.5.0
expect "$(curl -fsS "$LIVE/health" | field status)" ok "live color after the refused deploy"

step "Deploy release 0.3.0 beside it. Its migration adds a column while blue keeps serving."
$BG deploy hivear-draft:0.3.0
expect "$(dc exec -T db psql -U hivear -d hivear -Atc "select count(*) from information_schema.columns where table_schema='ar' and table_name='account' and column_name='drill_note'")" 1 "the new column exists while the previous release is live"
expect "$(curl -fsS "$PREVIEW/health" | field color)" green "preview port color"
expect "$(curl -fsS "$PREVIEW/health" | field release)" 0.3.0 "preview port release"
expect "$(curl -fsS "$PREVIEW/health" | field live)" False "preview is not live"
expect "$(curl -fsS "$LIVE/health" | field color)" blue "live port color before cutover"
expect "$(curl -fsS -H "$KEY" "$PREVIEW/accounts/$ACCOUNT" | field client_account_number)" DRILL-1 "green reads the account before cutover"
expect "$(payment "$PREVIEW")" 403 "a payment sent to the preview port"
# A header trick that once slipped a write past the preview refusal.
expect "$(payment "$PREVIEW" -H "Connection: X-Wax-Preview")" 403 "a payment sent to the preview port with a hop-by-hop header"
expect "$(curl -fsS "$PREVIEW/health" | field preview)" True "the preview port says it is the preview"
expect "$(curl -s -o /dev/null -w '%{http_code}' "$SITE/")" 200 "the frontend on the live port"
expect "$(curl -s -o /dev/null -w '%{http_code}' "$SITE/api/v1/docs")" 200 "the API documentation page"
refused $BG rollback

BLUE_ENTRY="$(curl -fsS "$LIVE/health" | field frontend_entry)"

step "Cutover"
$BG cutover
sleep 3
# A page loaded from blue a moment ago still gets blue's script, through the live port.
expect "$(curl -s -o /dev/null -w '%{http_code}' "$SITE$BLUE_ENTRY")" 200 "the previous build's script, asked of the live port after cutover"
expect "$(curl -fsS "$LIVE/health" | field color)" green "live port color after cutover"
expect "$(curl -fsS "$LIVE/health" | field live)" True "green reports itself live"
refused $BG cutover

step "Rollback"
$BG rollback
sleep 3
expect "$(curl -fsS "$LIVE/health" | field color)" blue "live port color after rollback"

step "Cutover again, then retire blue"
$BG cutover
sleep 3
$BG finalize
sleep 3
expect "$(curl -fsS "$LIVE/health" | field color)" green "live port color at the end"
expect "$(curl -s -o /dev/null -w '%{http_code}' "$SITE$BLUE_ENTRY")" 404 "the previous build's script once that color is retired"
refused $BG rollback

step "Stop traffic and check the books"
touch "$WORK/stop"; wait $LOAD 2>/dev/null || true
PAYMENTS="$(grep -c . "$WORK/payments")"
ACCEPTED="$(grep -c '^202$' "$WORK/payments" || true)"
expect "$ACCEPTED" "$PAYMENTS" "payments accepted out of $PAYMENTS sent"
expect "$(grep -c failed "$WORK/served" || true)" 0 "failed health reads"
echo "served by: $(sort "$WORK/served" | uniq -c | tr '\n' ';')"
[ "$(sort -u "$WORK/served" | grep -c .)" = 2 ] || { echo "FAILED: both releases should have served traffic"; exit 1; }

dc exec -T app_green python manage.py smoke_check --wait-seconds 60 > /dev/null
expect "$(curl -fsS -H "$KEY" "$LIVE/accounts/$ACCOUNT" | field balance_minor_units)" "$((OPENING - PAYMENTS))" "read model balance after $PAYMENTS one-unit payments"
expect "$(dc exec -T db psql -U hivear -d hivear -Atc "select sum(balance_minor_units) from ar.account_balance_bucket")" "$((OPENING - PAYMENTS))" "authoritative balance"
TARGET_IMAGE=hivear-draft:0.3.0 dc --profile tools run --rm -T --no-deps release python manage.py verify_chain

step "The previous release can still come back as the idle color, with no migration"
$BG deploy hivear-draft:0.2.0 | grep -E "earlier release|is ready"
expect "$(curl -fsS "$PREVIEW/health" | field release)" 0.2.0 "preview port release"
$BG finalize > /dev/null

step "A release two steps ahead is refused, and the offline path completes the same jump"
refused $BG deploy hivear-draft:0.5.0
$BG upgrade-offline hivear-draft:0.5.0 | grep -E "^== "
expect "$(curl -fsS "$LIVE/health" | field release)" 0.5.0 "live release after the offline upgrade from 0.3.0"
expect "$(payment "$LIVE")" 202 "a payment after the offline upgrade"
$BG status

step "The previous release's own tests, against the next release's schema"
deploy/compat_test.sh hivear-draft:0.2.0 hivear-draft:0.3.0 | grep -E "^==|passed|failed|ERROR"

step "Drill passed"
