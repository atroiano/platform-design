#!/usr/bin/env bash
# Blue-green release tooling for the reference Compose deployment (SHARED-0010).
#
#   init <image>             first install on an empty database
#   start                    bring a stopped installation back up as recorded
#   deploy <image>           bring <image> up as the idle color and test it; live traffic is untouched
#   cutover                  send live traffic to the candidate that deploy prepared
#   rollback                 send live traffic back to the color it came from
#   finalize                 stop the previous color; rollback is no longer possible
#   upgrade-offline <image>  maintenance-window upgrade across more than one release
#   repair                   rewrite the proxy routing from the database's record
#   status                   show both colors and whether proxy, files, and database agree
#
# The database's deployment record is the authority on which color is live.
set -euo pipefail
cd "$(dirname "$0")/.."

STATE="${HIVEAR_STATE_FILE:-deploy/state.env}"
export HIVEAR_PROXY_DIR="${HIVEAR_PROXY_DIR:-./deploy/proxy}"
mkdir -p "$HIVEAR_PROXY_DIR" "$(dirname "$STATE")"
[ -f "$STATE" ] || printf 'BLUE_IMAGE=\nGREEN_IMAGE=\n' > "$STATE"
ENV_FILES=()
[ -f .env ] && ENV_FILES+=(--env-file .env)
ENV_FILES+=(--env-file "$STATE")

dc() { docker compose "${ENV_FILES[@]}" "$@"; }
say() { printf '\n== %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }
other() { [ "$1" = blue ] && echo green || echo blue; }
image_of() { grep "^$(upper "$1")_IMAGE=" "$STATE" | cut -d= -f2-; }

set_image() {
    grep -v "^$(upper "$1")_IMAGE=" "$STATE" > "$STATE.tmp" || true
    printf '%s_IMAGE=%s\n' "$(upper "$1")" "$2" >> "$STATE.tmp"
    mv "$STATE.tmp" "$STATE"
}

need_image() {
    local image; image="$(image_of "$1")"
    [ -n "$image" ] || die "no image is recorded for $1 in $STATE; run: $0 deploy <image>"
    printf '%s' "$image"
}

# One value from the single-row deployment record. Empty if there is none.
record() {
    dc exec -T db psql -U hivear -d hivear -Atc "select coalesce($1, '') from core.deployment_state" 2>/dev/null || true
}
db_up() { [ -n "$(dc ps -q --status running db 2>/dev/null)" ]; }
installed() { [ "$(dc exec -T db psql -U hivear -d hivear -Atc "select count(*) from core.component_release" 2>/dev/null || echo 0)" != 0 ]; }
running() { [ -n "$(dc ps -q --status running "$1" 2>/dev/null)" ]; }
file_color() { [ -f "$HIVEAR_PROXY_DIR/live.caddy" ] && grep -o 'app_[a-z]*' "$HIVEAR_PROXY_DIR/live.caddy" | head -1 | cut -c5- || true; }
# The color the proxy is actually sending users to, asked through the proxy.
served_color() {
    dc exec -T proxy wget -qO- http://127.0.0.1:80/api/v1/health 2>/dev/null \
        | grep -Eo '"color": *"[a-z]+"' | grep -Eo 'blue|green' || true
}

# Asked through the proxy's preview listener: does the color behind it know
# it is being previewed? If not, it would accept writes from a tester.
preview_is_read_only() {
    dc exec -T proxy wget -qO- http://127.0.0.1:8081/api/v1/health 2>/dev/null | grep -Eq '"preview": *true'
}

# Run a management command with the owner's credentials, on a chosen image.
release_tool() {
    local image="$1"; shift
    TARGET_IMAGE="$image" dc --profile tools run --rm -T --no-deps release python manage.py "$@"
}

# The live route, and the preview route to the other color's preview listener.
# While the other color is running, a page loaded before a switch may still
# ask for a hashed file that only it has, so a missing asset is looked for
# there before it is a 404. When the other color is not running there is
# nowhere else to look, and the route is the plain one.
write_routes() {
    local live="$1" idle
    idle="$(other "$1")"
    if running "app_$idle"; then
        cat > "$HIVEAR_PROXY_DIR/live.caddy" <<ROUTES
@assets path /assets/*
handle @assets {
	reverse_proxy app_${live}:8000 {
		@missing status 404
		handle_response @missing {
			reverse_proxy app_${idle}:8000
		}
	}
}
handle {
	reverse_proxy app_${live}:8000
}
ROUTES
    else
        printf 'reverse_proxy app_%s:8000\n' "$live" > "$HIVEAR_PROXY_DIR/live.caddy"
    fi
    printf 'reverse_proxy app_%s:8001\n' "$idle" > "$HIVEAR_PROXY_DIR/preview.caddy"
}

reload_proxy() {
    dc exec -T proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile 2>/dev/null
}

# Write the routing for a live color and make the proxy load it. If the proxy
# refuses the new configuration, the previous files are put back, so the files
# on disk always describe what the proxy is actually doing.
apply_routes() {
    local keep="$HIVEAR_PROXY_DIR/.previous"
    rm -rf "$keep"; mkdir -p "$keep"
    cp "$HIVEAR_PROXY_DIR"/*.caddy "$keep"/ 2>/dev/null || true
    write_routes "$1"
    if reload_proxy; then
        rm -rf "$keep"
        return 0
    fi
    cp "$keep"/*.caddy "$HIVEAR_PROXY_DIR"/ 2>/dev/null || true
    rm -rf "$keep"
    return 1
}

# Refuse to act when the database, the routing files, and the proxy disagree
# about which color is live. Acting on a wrong belief moves real traffic.
require_consistent() {
    db_up || die "the database is not running; run: $0 start"
    local recorded filed served
    recorded="$(record active_color)"; filed="$(file_color)"; served="$(served_color)"
    [ -n "$recorded" ] || die "this database has no deployment record; run: $0 init <image>"
    [ "$recorded" = "$filed" ] || die "the database says $recorded is live and the routing files say ${filed:-nothing}; run: $0 repair"
    [ "$recorded" = "$served" ] || die "the database says $recorded is live and the proxy is serving ${served:-nothing}; run: $0 start, or $0 repair"
}

wait_healthy() {
    local id status
    for _ in $(seq 1 60); do
        id="$(dc ps -q "app_$1" 2>/dev/null || true)"
        status="$([ -n "$id" ] && docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo starting)"
        [ "$status" = healthy ] && return 0
        sleep 2
    done
    dc logs --tail 30 "app_$1" >&2
    die "app_$1 did not become healthy"
}

start_color() {
    local color="$1" image="$2"
    set_image "$color" "$image"
    dc --profile "$color" up -d --no-deps --force-recreate "app_$color" "worker_$color"
    wait_healthy "$color"
}

stop_color() {
    dc --profile "$1" stop "app_$1" "worker_$1" 2>/dev/null || true
    dc --profile "$1" rm -f "app_$1" "worker_$1" 2>/dev/null || true
}

smoke() {
    dc exec -T "app_$1" python manage.py smoke_check --wait-seconds "${2:-120}"
}

# Preflight, then migrate unless this image is an earlier release the schema
# still supports. Migrations run under a lock timeout and are retried.
prepare_schema() {
    local image="$1" mode attempt; shift
    say "Preflight: migration compatibility and upgrade path"
    mode="$(release_tool "$image" deployment preflight "$@" | grep -Eo '"mode": *"[a-z_]+"' | grep -Eo 'migrate|code_only')" \
        || die "preflight refused this release; nothing was changed"
    if [ "$mode" = code_only ]; then
        say "$image is an earlier release that this schema still supports: no migration"
        return 0
    fi
    say "Migrate"
    for attempt in 1 2 3; do
        release_tool "$image" migrate --noinput && break
        [ "$attempt" = 3 ] && die "migration failed three times; the schema is unchanged by the failed step"
        echo "migration could not get its locks; retrying"; sleep 5
    done
    release_tool "$image" deployment record-schema > /dev/null
}

case "${1:-status}" in
init)
    image="${2:?usage: bluegreen.sh init <image>}"
    dc up -d db pgbouncer
    for _ in $(seq 1 30); do db_up && dc exec -T db pg_isready -U hivear -d hivear > /dev/null 2>&1 && break; sleep 1; done
    installed && die "this database already holds an installation; use start, deploy, or upgrade-offline"
    prepare_schema "$image"
    release_tool "$image" deployment activate blue > /dev/null
    write_routes blue
    start_color blue "$image"
    dc up -d --no-deps proxy
    reload_proxy || true
    say "blue is live on port ${HIVEAR_HTTP_PORT:-8580} with $image"
    ;;
start)
    dc up -d db pgbouncer
    for _ in $(seq 1 30); do dc exec -T db pg_isready -U hivear -d hivear > /dev/null 2>&1 && break; sleep 1; done
    live="$(record active_color)"
    [ -n "$live" ] || die "this database has no deployment record; run: $0 init <image>"
    image="$(need_image "$live")"
    running "app_$live" || start_color "$live" "$image"
    write_routes "$live"
    dc up -d --no-deps proxy
    reload_proxy || die "proxy reload failed"
    say "$live is live with $image"
    ;;
repair)
    db_up || die "the database is not running; run: $0 start"
    live="$(record active_color)"
    [ -n "$live" ] || die "this database has no deployment record"
    running "app_$live" || die "the recorded live color ($live) is not running; run: $0 start"
    apply_routes "$live" || die "the proxy refused its configuration; routing is unchanged"
    say "routing rewritten: $live is live, as the database records"
    ;;
deploy)
    image="${2:?usage: bluegreen.sh deploy <image>}"
    [ "${3:-}" = "" ] || die "deploy takes one argument; for a maintenance-window upgrade use upgrade-offline"
    require_consistent
    live="$(record active_color)"; target="$(other "$live")"
    prepare_schema "$image"
    say "Start $target with $image (no user traffic)"
    start_color "$target" "$image"
    say "Smoke check inside $target"
    smoke "$target" 300 || die "$target failed its smoke check; live traffic is untouched and $target is not a candidate"
    # Routing does not change, but the proxy rereads its configuration, which
    # ships beside this script and may be newer than what it has loaded.
    apply_routes "$live" || die "the proxy refused its configuration; live traffic is untouched and $target is not a candidate"
    preview_is_read_only || die "the preview port is not read-only; $target is not a candidate (is the Caddyfile current?)"
    release_tool "$image" deployment set-candidate "$target" > /dev/null
    say "$target is ready on the preview port ${HIVEAR_PREVIEW_PORT:-8581} (read-only)"
    echo "Test it, then run: deploy/bluegreen.sh cutover"
    ;;
cutover)
    require_consistent
    live="$(record active_color)"; target="$(record candidate_color)"
    [ -n "$target" ] || die "there is no candidate; run deploy first (to undo a cutover, use rollback)"
    image="$(need_image "$target")"
    running "app_$target" || die "$target is not running; run deploy again"
    wait_healthy "$target"
    smoke "$target" 120 > /dev/null || die "$target failed its smoke check; live traffic was not moved"
    release_tool "$image" deployment activate "$target" > /dev/null || die "could not record $target as live; nothing was changed"
    if ! apply_routes "$target"; then
        release_tool "$(need_image "$live")" deployment rollback > /dev/null
        die "the proxy refused its configuration; $live is still live"
    fi
    say "$target is live. $live is still running, read-only, on the preview port."
    echo "To go back: deploy/bluegreen.sh rollback    To retire $live: deploy/bluegreen.sh finalize"
    ;;
rollback)
    require_consistent
    live="$(record active_color)"; target="$(record previous_color)"
    [ -n "$target" ] || die "there is no previous color to return to (none was cut over from, or it was finalized)"
    image="$(need_image "$target")"
    running "app_$target" || die "$target is not running; redeploy its release with: $0 deploy $image"
    wait_healthy "$target"
    smoke "$target" 120 > /dev/null || die "$target failed its smoke check; live traffic was not moved"
    release_tool "$image" deployment rollback > /dev/null || die "could not record the rollback; nothing was changed"
    if ! apply_routes "$target"; then
        release_tool "$(need_image "$live")" deployment activate "$live" > /dev/null
        die "the proxy refused its configuration; $live is still live"
    fi
    say "$target is live again. $live is still running and is the candidate; cutover retries it."
    ;;
finalize)
    require_consistent
    live="$(record active_color)"; idle="$(other "$live")"
    smoke "$live" 60 > /dev/null || die "$live fails its smoke check; not stopping $idle"
    release_tool "$(need_image "$live")" deployment finalize > /dev/null
    stop_color "$idle"
    # The retired color can no longer answer for a missing asset.
    apply_routes "$live" || die "$idle is stopped, but the proxy refused its configuration; run: $0 repair"
    say "$idle is stopped. $live is the only color running."
    ;;
upgrade-offline)
    image="${2:?usage: bluegreen.sh upgrade-offline <image>}"
    db_up || dc up -d db pgbouncer
    live="$(record active_color)"
    [ -n "$live" ] || die "this database has no deployment record; run: $0 init <image>"
    say "Stopping the application: users will see errors until the upgrade finishes"
    stop_color blue; stop_color green
    sleep 21   # let the workers' heartbeats lapse, which is what preflight checks
    prepare_schema "$image" --offline
    release_tool "$image" deployment activate "$live" > /dev/null
    release_tool "$image" deployment finalize > /dev/null
    write_routes "$live"
    start_color "$live" "$image"
    dc up -d --no-deps proxy
    reload_proxy || die "proxy reload failed"
    smoke "$live" 300 || die "$live is running $image and fails its smoke check"
    say "$live is live with $image"
    ;;
status)
    if db_up; then
        printf 'database record: live=%s candidate=%s previous=%s\n' "$(record active_color)" "$(record candidate_color)" "$(record previous_color)"
    else
        echo "database record: database is not running"
    fi
    printf 'routing files:   live=%s\n' "$(file_color)"
    printf 'proxy serves:    %s\n' "$(served_color)"
    for color in blue green; do
        if running "app_$color"; then
            health="$(dc exec -T "app_$color" python -c "
import urllib.request, urllib.error
try: print(urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=3).read().decode()[:160])
except urllib.error.HTTPError as e: print(e.code, e.read().decode()[:160])" 2>/dev/null || echo unreachable)"
        else
            health="app not running"
        fi
        running "worker_$color" && worker="worker up" || worker="worker DOWN"
        printf '%-6s %-26s %-12s %s\n' "$color" "$(image_of "$color")" "$worker" "$health"
    done
    ;;
*)
    sed -n '2,15p' "$0"; exit 2
    ;;
esac
