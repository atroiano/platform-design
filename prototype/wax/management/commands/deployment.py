import json

from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction

from wax import projections, release


class Command(BaseCommand):
    """Deployment state changes. These run with the owner's credentials, from
    the release tooling. The runtime role can read the state and nothing more."""

    help = "Preflight an upgrade, record the schema release, or change which color is live."

    def add_arguments(self, parser):
        parser.add_argument(
            "action",
            choices=["status", "preflight", "record-schema", "set-candidate", "activate", "rollback", "finalize"],
        )
        parser.add_argument("color", nargs="?", choices=["blue", "green"])
        parser.add_argument(
            "--offline",
            action="store_true",
            help="The application is stopped, so the release now live need not keep working.",
        )

    def handle(self, *args, action, color, offline, **options):
        result = {}
        if action == "preflight":
            result["mode"] = self.preflight(offline)
        elif action == "record-schema":
            self.record_schema()
        elif action in ("set-candidate", "activate"):
            if not color:
                raise CommandError(f"{action} needs a color")
            getattr(self, action.replace("-", "_"))(color)
        elif action == "rollback":
            self.rollback()
        elif action == "finalize":
            self.execute_sql(
                "UPDATE core.deployment_state SET previous_color = NULL, candidate_color = NULL, changed_at = now()"
            )
        self.stdout.write(json.dumps({**result, **self.snapshot()}, default=str))

    def execute_sql(self, sql, params=None):
        with connection.cursor() as cursor:
            cursor.execute(sql, params)

    def installed(self):
        with connection.cursor() as cursor:
            cursor.execute("SELECT to_regclass('core.component_release')")
            return cursor.fetchone()[0] is not None

    def snapshot(self):
        if not self.installed():
            return {"components": {}}
        return {**release.deployment_state(), "components": release.recorded_components()}

    def preflight(self, offline):
        """Run by the new release's image before it changes anything. Returns
        "migrate", or "code_only" when this image is an earlier release that
        the current schema still supports."""
        call_command("check_migrations")
        recorded = release.recorded_components() if self.installed() else {}
        carried = release.components()
        if offline:
            for color in ("blue", "green"):
                age = projections.heartbeat_age_seconds(color) if recorded else None
                if age is not None and age < 20:
                    raise CommandError(f"--offline means the application is stopped, but the {color} worker is running.")

        older, newer = [], []
        for name, row in recorded.items():
            mine = carried.get(name)
            if mine is None:
                raise CommandError(f"{name} is installed in this database and missing from this image.")
            if release.parse(mine.release) < release.parse(row["minimum_code_release"]):
                raise CommandError(
                    f"{name} {mine.release} is too old for this database, which supports "
                    f"{name} from {row['minimum_code_release']} onward."
                )
            if release.parse(mine.release) < release.parse(row["schema_release"]):
                older.append(name)
            elif release.parse(mine.release) > release.parse(row["schema_release"]):
                newer.append(name)
            live = row["live_release"]
            # More than one minor release at a time cannot be done beside a
            # live release, whatever floor the build states (SHARED-0010).
            if live and not offline:
                live_major, live_minor = release.minor(live)
                major, minor_number = release.minor(mine.release)
                if major != live_major or minor_number > live_minor + 1:
                    raise CommandError(
                        f"{name} {live} is serving users and this is {name} {mine.release}, more than one "
                        f"release ahead. Upgrade one release at a time, or stop the application and "
                        f"use the offline upgrade."
                    )
            if live and release.parse(mine.minimum_code_release) > release.parse(live) and not offline:
                raise CommandError(
                    f"{name} {live} is serving users. After this upgrade the schema would support "
                    f"{name} from {mine.minimum_code_release} onward, so the live release would "
                    f"break before cutover. Upgrade one release at a time, or stop the "
                    f"application and use the offline upgrade."
                )
        if older and newer:
            raise CommandError(f"This image moves {newer} forward and {older} back. Upgrade them separately.")
        return "code_only" if older else "migrate"

    @transaction.atomic
    def record_schema(self):
        """Raise the recorded schema release. It is never lowered."""
        recorded = release.recorded_components()
        for name, mine in release.components().items():
            row = recorded.get(name)
            if row is None:
                self.execute_sql(
                    "INSERT INTO core.component_release (component, schema_release, minimum_code_release) "
                    "VALUES (%s, %s, %s)",
                    [name, mine.release, mine.minimum_code_release],
                )
            elif release.parse(mine.release) > release.parse(row["schema_release"]):
                self.execute_sql(
                    "UPDATE core.component_release SET schema_release = %s, minimum_code_release = %s, "
                    "changed_at = now() WHERE component = %s",
                    [mine.release, mine.minimum_code_release, name],
                )

    def set_candidate(self, color):
        if release.deployment_state()["active_color"] == color:
            raise CommandError(f"{color} is live; it cannot also be the candidate.")
        self.execute_sql("UPDATE core.deployment_state SET candidate_color = %s, changed_at = now()", [color])

    @transaction.atomic
    def activate(self, color):
        """Make a color live. The color it replaces becomes the rollback target."""
        problems = release.incompatibilities()
        if problems:
            raise CommandError("; ".join(problems))
        state = release.deployment_state()
        previous = state["active_color"] if state["active_color"] != color else state["previous_color"]
        self.execute_sql(
            "UPDATE core.deployment_state SET active_color = %s, previous_color = %s, "
            "candidate_color = NULL, changed_at = now()",
            [color, previous],
        )
        for name, mine in release.components().items():
            self.execute_sql(
                "UPDATE core.component_release SET live_release = %s, changed_at = now() WHERE component = %s",
                [mine.release, name],
            )

    @transaction.atomic
    def rollback(self):
        """Return to the previous color. Run with that color's image. The
        color being left becomes the candidate again, so it can be retried."""
        state = release.deployment_state()
        if not state["previous_color"]:
            raise CommandError("There is no previous color to roll back to.")
        self.activate(state["previous_color"])
        self.execute_sql(
            "UPDATE core.deployment_state SET candidate_color = %s, previous_color = NULL, changed_at = now()",
            [state["active_color"]],
        )
