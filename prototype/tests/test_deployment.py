"""Release rollout rules from SHARED-0010: the migration compatibility check,
the per-component schema interlock, the runtime role, and why the rules exist."""

import io
import json

import pytest
from django.contrib.postgres.operations import AddIndexConcurrently, ValidateConstraint
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError, connection, migrations, models, transaction
from django.test import Client

from hivear import commands
from tests.conftest import ACTOR, balances
from wax import migration_safety, release
from wax.commands import dispatch
from wax.migration_operations import DropColumn, DropIndex, DropTable, Reviewed


def migration(*operations, wax_release="1.4.0", **attributes):
    body = {"operations": list(operations), "wax_release": wax_release, **attributes}
    return type("Migration", (migrations.Migration,), body)("0099_example", "hivear")


def problems(*operations, earlier=(), **attributes):
    return [p.operation for p in migration_safety.audit("hivear", migration(*operations, **attributes), earlier)]


def test_additive_changes_pass():
    assert problems(
        migrations.AddField("account", "note", models.TextField(null=True)),
        migrations.AddField("account", "flag", models.BooleanField(db_default=False)),
        migrations.CreateModel("Letter", [("letter_pk", models.UUIDField(primary_key=True))]),
        migrations.AddIndex("letter", models.Index(fields=["letter_pk"], name="idx_letter")),
    ) == []
    concurrent = AddIndexConcurrently("account", models.Index(fields=["status"], name="idx_account_status"))
    assert problems(concurrent, atomic=False) == []


def test_every_migration_states_the_release_it_shipped_in():
    add = migrations.AddField("account", "note", models.TextField(null=True))
    assert problems(add, wax_release=None) == ["wax_release"]
    assert problems(add, wax_release="1.4") == ["wax_release"]
    assert problems(add, wax_release="next") == ["wax_release"]


def test_changes_the_previous_release_cannot_survive_are_rejected():
    assert problems(migrations.AddField("account", "required", models.TextField())) == ["AddField"]
    assert problems(migrations.RemoveField("account", "status")) == ["RemoveField"]
    assert problems(migrations.RenameField("account", "status", "state")) == ["RenameField"]
    assert problems(migrations.DeleteModel("Payment")) == ["DeleteModel"]
    assert problems(migrations.AddIndex("account", models.Index(fields=["status"], name="idx_x"))) == ["AddIndex"]
    assert problems(migrations.RunSQL("UPDATE ar.account SET status = 'x'")) == ["RunSQL"]
    assert problems(migrations.AlterField("account", "status", models.CharField(max_length=5))) == ["AlterField"]
    assert problems(migrations.RemoveConstraint("accountbalancebucket", "some_unique")) == ["RemoveConstraint"]
    # Not even a reviewer's signature makes these applicable: Django can only
    # run them while the previous release still declares the field.
    assert problems(Reviewed(migrations.RemoveField("account", "status"), "trust me")) == ["RemoveField"]


def test_a_column_that_passes_as_additive_but_locks_the_table_is_rejected():
    def add(field):
        return problems(migrations.AddField("payment", "x", field))

    account = "hivear.account"
    assert add(models.ForeignKey(account, models.PROTECT, null=True)) == ["AddField"]
    assert add(models.TextField(null=True, db_index=True)) == ["AddField"]
    assert add(models.TextField(null=True, unique=True)) == ["AddField"]
    assert add(models.OneToOneField(account, models.PROTECT, null=True)) == ["AddField"]
    assert add(models.DateTimeField(db_default=models.functions.Now())) == ["AddField"]
    # The safe shape: a bare column now, its index and constraint in later migrations.
    assert add(models.ForeignKey(account, models.PROTECT, null=True, db_constraint=False, db_index=False)) == []


def test_removal_takes_two_releases_and_the_check_verifies_both():
    stop_using = migrations.SeparateDatabaseAndState(state_operations=[migrations.RemoveField("account", "status")])
    assert problems(stop_using, wax_release="1.3.0") == [], "a state-only change does not touch the database"

    earlier = [("1.3.0", migration(stop_using, wax_release="1.3.0"))]
    drop = DropColumn("account", "status")
    assert problems(drop, earlier=earlier, wax_release="1.4.0") == []
    assert problems(drop, earlier=earlier, wax_release="1.3.1") == ["DropColumn"], "same release line"
    assert problems(drop, earlier=(), wax_release="1.4.0") == ["DropColumn"], "nobody stopped using it"

    deleted = [("1.3.0", migration(migrations.SeparateDatabaseAndState(state_operations=[migrations.DeleteModel("Letter")]), wax_release="1.3.0"))]
    assert problems(DropTable("letter", "ar.letter"), earlier=deleted) == []
    assert problems(DropTable("letter", "ar.letter"), earlier=earlier) == ["DropTable"]


def test_unprovable_operations_are_reviewed_one_at_a_time_with_a_reason():
    backfill = migrations.RunSQL("UPDATE ar.account SET note = '' WHERE note IS NULL")
    other = migrations.RunSQL("ALTER TABLE ar.account ALTER COLUMN note SET NOT NULL")
    assert problems(Reviewed(backfill, "batched, idempotent; the previous release ignores note")) == []
    assert problems(Reviewed(backfill, " ")) == ["RunSQL"]
    assert problems(Reviewed(backfill, "fine"), other) == ["RunSQL"], "one review does not cover the next operation"


def test_concurrent_and_validating_steps_stand_alone_outside_a_transaction():
    concurrent = AddIndexConcurrently("account", models.Index(fields=["status"], name="idx_account_status"))
    assert problems(concurrent) == ["AddIndexConcurrently"], "CONCURRENTLY cannot run in a transaction"
    assert "atomic" in problems(concurrent, migrations.AddField("account", "n", models.TextField(null=True)), atomic=False)
    assert problems(DropIndex("ar.idx_account_status"), atomic=False) == []
    assert problems(migrations.RemoveIndex("account", "idx_account_status")) == ["RemoveIndex"]
    validate = Reviewed(ValidateConstraint("account", "account_status_known"), "added not valid in 1.3.0")
    add = Reviewed(migrations.RunSQL("ALTER TABLE ar.account ADD CONSTRAINT c CHECK (true) NOT VALID"), "not valid")
    assert problems(validate) == []
    assert "atomic" in problems(add, validate)


def test_this_repository_passes_its_own_check():
    call_command("check_migrations")


@pytest.mark.django_db
def test_the_previous_release_survives_an_additive_migration_but_not_a_required_column(place, run):
    """Why the rule exists. This code plays the previous release; the ALTER
    statements play the next release's migration."""
    with connection.cursor() as cursor:
        cursor.execute("ALTER TABLE ar.account ADD COLUMN added_by_next_release text")
    account_pk = place(principal=10_000)
    run(commands.PostPayment(account_pks=[account_pk], amount_minor_units=2_500, currency_code="USD"))
    assert balances(account_pk) == {"principal": 7_500}

    with connection.cursor() as cursor:
        cursor.execute("ALTER TABLE ar.account ADD COLUMN required_by_next_release text NOT NULL DEFAULT 'x'")
        cursor.execute("ALTER TABLE ar.account ALTER COLUMN required_by_next_release DROP DEFAULT")
    with pytest.raises(DatabaseError):
        place(principal=10_000)


@pytest.fixture
def at_release_100(monkeypatch):
    """These tests record schema releases and compare them with the code's
    own. They must mean the same thing whatever release the image was built as."""
    pinned = {name: release.Component(name, "1.0.0", "1.0.0", c.apps) for name, c in release.components().items()}
    monkeypatch.setattr(release, "_components", pinned)


def record(component, schema, minimum, live=None):
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO core.component_release (component, schema_release, minimum_code_release, live_release) "
            "VALUES (%s, %s, %s, %s) ON CONFLICT (component) DO UPDATE SET schema_release = EXCLUDED.schema_release, "
            "minimum_code_release = EXCLUDED.minimum_code_release, live_release = EXCLUDED.live_release",
            [component, schema, minimum, live],
        )


def deployment(*args):
    out = io.StringIO()
    call_command("deployment", *args, stdout=out)
    return json.loads(out.getvalue().strip().splitlines()[-1])


@pytest.mark.django_db
def test_code_refuses_a_database_that_has_moved_past_it(at_release_100, place, run):
    release.assert_schema_supports_this_code()
    assert Client().get("/api/v1/health").json()["status"] == "ok"
    account_pk = place(principal=1_000)

    record("hivear", "9.1.0", "9.0.0")
    release._cache["problems"] = None
    with pytest.raises(release.IncompatibleSchema):
        release.assert_schema_supports_this_code()
    response = Client().get("/api/v1/health")
    assert response.status_code == 503 and response.json()["status"] == "incompatible_schema"
    # It stops writing, not only reporting.
    with pytest.raises(release.IncompatibleSchema):
        dispatch(commands.OpenDispute(account_pk=account_pk), actor_pk=ACTOR)


@pytest.mark.django_db
def test_an_image_missing_an_installed_component_may_not_run():
    record("healthcare", "2.3.0", "2.2.0")
    assert "missing from this image" in release.incompatibilities()[0]


@pytest.mark.django_db
def test_preflight_compares_with_the_release_serving_users(at_release_100, monkeypatch):
    for name in ("wax", "hivear"):
        record(name, "1.0.0", "1.0.0", live="1.0.0")
    assert deployment("preflight")["mode"] == "migrate"

    # Two releases ahead: this image's schema would no longer support what is live.
    ahead = {n: release.Component(n, "1.2.0", "1.1.0", c.apps) for n, c in release.components().items()}
    monkeypatch.setattr(release, "_components", ahead)
    with pytest.raises(CommandError, match="serving users"):
        deployment("preflight")
    assert deployment("preflight", "--offline")["mode"] == "migrate"

    # The distance is refused whatever floor the build states: a build that
    # claims to support the live release is still two releases away from it.
    lenient = {n: release.Component(n, "1.2.0", "1.0.0", c.apps) for n, c in release.components().items()}
    monkeypatch.setattr(release, "_components", lenient)
    with pytest.raises(CommandError, match="more than one release ahead"):
        deployment("preflight")
    adjacent = {n: release.Component(n, "1.1.0", "1.0.0", c.apps) for n, c in release.components().items()}
    monkeypatch.setattr(release, "_components", adjacent)
    assert deployment("preflight")["mode"] == "migrate"


@pytest.mark.django_db
def test_an_earlier_release_the_schema_still_supports_deploys_without_migrating(at_release_100):
    for name in ("wax", "hivear"):
        record(name, "1.1.0", "1.0.0", live="1.1.0")
    assert deployment("preflight")["mode"] == "code_only"

    deployment("record-schema")   # run by the older image: the record is never lowered
    assert release.recorded_components()["hivear"]["schema_release"] == "1.1.0"

    record("hivear", "1.9.0", "1.8.0", live="1.9.0")
    with pytest.raises(CommandError, match="too old"):
        deployment("preflight")


@pytest.mark.django_db
def test_cutover_rollback_and_finalize_are_distinct_states(at_release_100):
    for name in ("wax", "hivear"):
        record(name, "1.0.0", "1.0.0")
    state = release.deployment_state()
    assert (state["active_color"], state["candidate_color"], state["previous_color"]) == ("blue", None, None)
    with pytest.raises(CommandError, match="no previous color"):
        deployment("rollback")

    deployment("set-candidate", "green")
    state = deployment("activate", "green")
    assert (state["active_color"], state["candidate_color"], state["previous_color"]) == ("green", None, "blue")
    assert state["components"]["hivear"]["live_release"] == "1.0.0"

    state = deployment("rollback")
    assert (state["active_color"], state["candidate_color"], state["previous_color"]) == ("blue", "green", None)

    deployment("activate", "green")
    state = deployment("finalize")
    assert (state["active_color"], state["candidate_color"], state["previous_color"]) == ("green", None, None)


def test_the_floor_is_the_previous_minor_release_unless_a_build_says_otherwise():
    assert release.previous_minor("1.4.2") == "1.3.0"
    assert release.previous_minor("0.2.0") == "0.1.0"
    assert release.previous_minor("2.0.0") == "2.0.0"


def test_release_numbers_are_strict_and_compare_numerically():
    assert release.parse("1.10.0") > release.parse("1.9.3")
    assert release.parse("0.2.0-drill") == (0, 2, 0)
    for bad in ("1.3", "next", "", None, "v1.2.3"):
        with pytest.raises(ValueError):
            release.parse(bad)


@pytest.mark.django_db
def test_the_preview_port_cannot_write(place):
    """A request is preview traffic because of the listener it arrived on.
    No header a client sends makes it so, and none undoes it."""
    account_pk = place(principal=1_000)
    body = json.dumps({"account_pks": [str(account_pk)], "amount_minor_units": 1, "currency_code": "USD"})
    keyed = {"HTTP_X_API_KEY": "local-evaluation-only"}
    send = {"data": body, "content_type": "application/json", **keyed}
    client, preview = Client(), {"SERVER_PORT": "8001"}

    assert client.post("/api/v1/commands/post-payment", **send, **preview).status_code == 403
    # The old header-based mark, and the hop-by-hop trick that used to strip it, change nothing.
    assert client.post("/api/v1/commands/post-payment", **send, **preview, HTTP_CONNECTION="X-Wax-Preview").status_code == 403
    assert client.get("/api/v1/health", **preview).json()["preview"] is True
    assert client.get(f"/api/v1/accounts/{account_pk}/history", **keyed, **preview).status_code == 200

    assert client.get("/api/v1/health", HTTP_X_WAX_PREVIEW="1").json()["preview"] is False
    assert client.post("/api/v1/commands/post-payment", **send, HTTP_X_WAX_PREVIEW="1").status_code == 202
    assert balances(account_pk) == {"principal": 999}


@pytest.mark.django_db
def test_the_runtime_role_cannot_change_history_schema_or_deployment_state(place):
    """The application connects as a member of wax_runtime."""
    place()
    forbidden = [
        "UPDATE core.event SET source = 'tampered'",
        "DELETE FROM core.event",
        "ALTER TABLE core.event DISABLE TRIGGER ALL",
        "UPDATE core.deployment_state SET active_color = 'green'",
        "INSERT INTO core.component_release (component, schema_release, minimum_code_release) VALUES ('x', '1.0.0', '1.0.0')",
        "ALTER TABLE ar.account ADD COLUMN sneaky text",
        "DELETE FROM ar.account",
    ]
    with connection.cursor() as cursor:
        # What a later release's migration would add, created by the owner.
        cursor.execute("CREATE TABLE core.later_table (later_table_pk uuid PRIMARY KEY)")
        cursor.execute("CREATE TABLE ar.later_table (later_table_pk uuid PRIMARY KEY, n serial)")
        cursor.execute("SET LOCAL ROLE wax_runtime")
        for statement in forbidden:
            with pytest.raises(DatabaseError, match="permission denied|must be owner"), transaction.atomic():
                cursor.execute(statement)
        # Default privileges cover what later migrations add, sequences included.
        cursor.execute("SELECT count(*) FROM core.later_table")
        cursor.execute("INSERT INTO ar.later_table (later_table_pk) VALUES (gen_random_uuid())")
        # It can append, and the database, not the writer, numbers the row.
        cursor.execute(
            "INSERT INTO core.event (event_pk, global_sequence_number, recorded_at, aggregate_sequence_number,"
            " event_type, schema_version, aggregate_pk_ref, aggregate_type, occurred_at, actor_pk_ref,"
            " actor_type, event_hash) VALUES (gen_random_uuid(), -1, '2001-01-01', 1, 'role.test', 1,"
            " gen_random_uuid(), 'role_test', now(), gen_random_uuid(), 'system', 'h')"
            " RETURNING global_sequence_number, recorded_at > now() - interval '1 minute'"
        )
        sequence, recent = cursor.fetchone()
        cursor.execute("RESET ROLE")
    assert sequence > 0 and recent


@pytest.mark.django_db(transaction=True)
def test_a_schema_change_that_cannot_get_its_lock_fails_fast_and_succeeds_when_retried(place):
    """Why the release tooling sets a lock timeout and retries (SHARED-0010).
    Without the timeout the ALTER would wait behind the open transaction, and
    every request touching the table would queue behind the ALTER."""
    import time

    from django.db import OperationalError

    place()
    holder = connection.copy()
    holder.set_autocommit(False)
    try:
        with holder.cursor() as cursor:
            cursor.execute("SELECT count(*) FROM ar.account")      # an open transaction that has read the table
        with connection.cursor() as cursor:
            cursor.execute("SET lock_timeout = '300ms'")
            started = time.monotonic()
            with pytest.raises(OperationalError, match="lock timeout"):
                cursor.execute("ALTER TABLE ar.account ADD COLUMN lock_probe text")
            assert time.monotonic() - started < 3, "it must give up quickly, not queue"
        holder.rollback()                                           # the reader finishes
        with connection.cursor() as cursor:
            cursor.execute("ALTER TABLE ar.account ADD COLUMN lock_probe text")   # the retry goes through
            cursor.execute("ALTER TABLE ar.account DROP COLUMN lock_probe")
            cursor.execute("RESET lock_timeout")
    finally:
        holder.close()
