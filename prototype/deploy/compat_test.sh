#!/usr/bin/env bash
# The direct test of the migration compatibility rule (SHARED-0010): the
# PREVIOUS release's own test suite, run against a database migrated by the
# CANDIDATE release. Old code, new schema. If it passes, the previous release
# keeps working while the candidate is tested beside it and after a rollback.
#
#   deploy/compat_test.sh <previous image> <candidate image>
#
# Runs in its own Compose project and removes it afterward.
set -euo pipefail
cd "$(dirname "$0")/.."
previous="${1:?usage: compat_test.sh <previous image> <candidate image>}"
candidate="${2:?usage: compat_test.sh <previous image> <candidate image>}"

export COMPOSE_PROJECT_NAME=hivear-compat
report="$(mktemp)"
# The release service already carries the owner's credentials from the Compose file and .env.
tool() { local image="$1"; shift; TARGET_IMAGE="$image" docker compose --profile tools run --rm -T --no-deps "$@"; }
cleanup() { docker compose --profile tools down -v --remove-orphans > /dev/null 2>&1 || true; rm -f "$report"; }
trap cleanup EXIT

cleanup
docker compose up -d db > /dev/null
for _ in $(seq 1 30); do docker compose exec -T db pg_isready -U hivear -d hivear > /dev/null 2>&1 && break; sleep 1; done

echo "== The candidate ($candidate) migrates a fresh database"
docker compose exec -T db psql -U hivear -d postgres -qc "CREATE DATABASE test_compat OWNER hivear" 
tool "$candidate" -e DATABASE_NAME=test_compat release python manage.py migrate --noinput | tail -3

applied() { docker compose exec -T db psql -U hivear -d test_compat -Atc "select count(*) from django_migrations"; }
built="$(applied)"

echo "== The previous release ($previous) runs its own tests against that schema"
# --reuse-db keeps the schema the candidate built instead of building its own.
tool "$previous" -e DATABASE_NAME=compat release pytest -q --reuse-db -p no:cacheprovider | tee "$report"
# A run that collected nothing proves nothing.
grep -Eq '^[0-9]+ passed' "$report" || { echo "ERROR: no tests ran in the previous release's image"; exit 1; }
# Proof the suite ran on the candidate's schema and did not quietly rebuild its own.
[ "$(applied)" = "$built" ] || { echo "ERROR: the schema was rebuilt during the run; the result means nothing"; exit 1; }
echo "== Compatible: the previous release's suite passes on the candidate's schema ($built migrations applied)"
