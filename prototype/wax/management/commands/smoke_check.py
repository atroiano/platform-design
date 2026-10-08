import json
import time

from django.apps import apps
from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from django.db import connection
from django.db.migrations.executor import MigrationExecutor

from wax import projections, release, smoke, store
from wax.models import Event


class Command(BaseCommand):
    """Read-only checks run inside a color before it takes traffic.

    Nothing here writes a domain event: core.event is permanent, so the live
    database is never used for synthetic transactions (SHARED-0010).
    """

    help = "Verify that this release can serve from this database."

    def add_arguments(self, parser):
        parser.add_argument("--wait-seconds", type=int, default=0, help="Wait for projections to catch up.")
        parser.add_argument("--chain-sample", type=int, default=25)
        parser.add_argument("--no-worker", action="store_true", help="Do not require this color's worker.")

    def handle(self, *args, wait_seconds, chain_sample, no_worker, **options):
        results, failures = {}, []

        def step(name, function):
            try:
                results[name] = function() or "ok"
            except Exception as exc:
                results[name] = f"FAILED: {exc}"
                failures.append(name)

        step("schema_supports_this_code", release.assert_schema_supports_this_code)
        step("no_unapplied_migrations", self.no_unapplied_migrations)
        step("system_checks", lambda: call_command("check", verbosity=0))
        step("every_model_is_readable_and_writable", self.every_model_is_usable)
        if not no_worker:
            step("worker_is_alive", lambda: self.worker_is_alive(wait_seconds))
        step("projections_current", lambda: self.projections_current(wait_seconds))
        step("recent_hash_chains", lambda: self.recent_hash_chains(chain_sample))
        for name, probe in smoke.probes().items():
            step(name, probe)

        self.stdout.write(json.dumps({"release": release.RELEASE, "color": release.COLOR, **results}, indent=2, default=str))
        if failures:
            raise CommandError(f"Smoke check failed: {', '.join(failures)}")

    def no_unapplied_migrations(self):
        executor = MigrationExecutor(connection)
        plan = executor.migration_plan(executor.loader.graph.leaf_nodes())
        if plan:
            raise RuntimeError(f"{len(plan)} migrations this release needs are not applied")

    def every_model_is_usable(self):
        """Select every column of every first-party model, and confirm this
        database user holds the privileges the code will use. A missing
        column or grant fails here, not on a user's first request."""
        count, quote = 0, connection.ops.quote_name
        for config in apps.get_app_configs():
            if release.component_for_app(config.label) is None:
                continue
            for model in config.get_models():
                list(model._default_manager.all()[:1])
                needed = ["INSERT"] if model is Event else ["INSERT", "UPDATE"]
                with connection.cursor() as cursor:
                    for privilege in needed:
                        cursor.execute(
                            "SELECT has_table_privilege(current_user, %s, %s)",
                            [quote(model._meta.db_table), privilege],
                        )
                        if not cursor.fetchone()[0]:
                            raise RuntimeError(f"no {privilege} on {model._meta.db_table}")
                count += 1
        return f"{count} models"

    def worker_is_alive(self, wait_seconds):
        deadline = time.monotonic() + max(wait_seconds, 10)
        while True:
            age = projections.heartbeat_age_seconds(release.COLOR)
            if age is not None and age < 20:
                return f"last seen {age:.0f}s ago"
            if time.monotonic() >= deadline:
                raise RuntimeError(f"the {release.COLOR} worker has not reported in")
            time.sleep(1)

    def projections_current(self, wait_seconds):
        """Every projection must reach the position the stream was at when
        the check began. Under load there is no moment of zero lag to wait for."""
        projections.register_checkpoints()
        target = projections.sequence_position()
        deadline = time.monotonic() + wait_seconds
        while True:
            rows = projections.status()
            stopped = [f"{row['projection']} ({row['failure_kind']})" for row in rows if row["failed_at"]]
            if stopped:
                raise RuntimeError(f"stopped on an event: {', '.join(stopped)}")
            mismatched = [row["projection"] for row in rows if not row["definition_matches"]]
            if mismatched:
                raise RuntimeError(
                    f"another release defines these versions differently; register a new version: {', '.join(mismatched)}"
                )
            behind = {row["projection"]: target - row["position"] for row in rows if row["position"] < target}
            if not behind:
                return f"{len(rows)} projections at or past {target}"
            if time.monotonic() >= deadline:
                raise RuntimeError(f"still catching up: {behind}")
            time.sleep(1)

    def recent_hash_chains(self, sample):
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT aggregate_pk_ref FROM core.event GROUP BY aggregate_pk_ref "
                "ORDER BY max(global_sequence_number) DESC LIMIT %s",
                [sample],
            )
            aggregate_pks = [row[0] for row in cursor.fetchall()]
        for aggregate_pk in aggregate_pks:
            problems = store.verify_stream(aggregate_pk)
            if problems:
                raise RuntimeError(f"{aggregate_pk}: {problems[0]}")
        return f"{len(aggregate_pks)} aggregates"
