"""Static check of the migration compatibility rules in SHARED-0010.

The rule: every migration in a release must be safe to apply while the
previous release's code is still running against the same database, and must
not hold a lock that blocks a large table for more than a moment.

The check is conservative. It proves the common additive cases and the
two-release removal. Anything else must be wrapped, one operation at a time,
in wax.migration_operations.Reviewed with a reason a reviewer then reads.
Every checked migration states the release it shipped in:

    wax_release = "1.4.0"
"""

from dataclasses import dataclass

from django.contrib.postgres.operations import (
    AddIndexConcurrently,
    RemoveIndexConcurrently,
    ValidateConstraint,
)
from django.db import connection, migrations, models
from django.db.models import NOT_PROVIDED, Value

from wax import release
from wax.migration_operations import DropColumn, DropIndex, DropTable, Reviewed

# Django can only apply these while the model still declares the thing, which
# means the previous release still uses it. They are allowed as state-only
# changes and nowhere else.
STATE_ONLY = (
    migrations.RemoveField,
    migrations.DeleteModel,
    migrations.RenameField,
    migrations.RenameModel,
    migrations.AlterModelTable,
)
# On a schema-qualified table these emit an unqualified name and do nothing.
UNQUALIFIED = (migrations.RemoveIndex, migrations.RenameIndex, RemoveIndexConcurrently)
SAFE = (migrations.CreateModel, migrations.AlterModelOptions, migrations.AlterModelManagers)
NON_ATOMIC = (AddIndexConcurrently, DropIndex)
BASELINE_RELEASE = "0.0.0"


@dataclass(frozen=True)
class Problem:
    app_label: str
    migration: str
    operation: str
    message: str

    def __str__(self):
        return f"{self.app_label}.{self.migration}: {self.operation}: {self.message}"


def _split(operations):
    """(database operations, state-only operations), flattened."""
    database, state_only = [], []
    for operation in operations:
        if isinstance(operation, migrations.SeparateDatabaseAndState):
            inner_database, inner_state = _split(operation.database_operations)
            database += inner_database
            state_only += inner_state + list(operation.state_operations)
        else:
            database.append(operation)
    return database, state_only


def _stopped_using(earlier, wanted):
    """The release in which an earlier migration made the matching state-only
    change, or None. earlier is [(release, migration)] for the same app."""
    for shipped_in, migration in earlier:
        for operation in _split(migration.operations)[1]:
            if wanted(operation):
                return shipped_in
    return None


def _add_field_problem(operation):
    field = operation.field
    if field.many_to_many:
        return None
    database_default = getattr(field, "db_default", NOT_PROVIDED)
    if not field.null and database_default is NOT_PROVIDED:
        return (
            "adds a required column with no database default. The previous release does not "
            "know the column and its inserts would fail. Make it nullable or give it db_default."
        )
    if hasattr(database_default, "resolve_expression") and not isinstance(database_default, Value):
        return (
            "has a database default that is an expression. A volatile default rewrites the "
            "whole table under a lock. Use a constant, or add the column bare and backfill."
        )
    if isinstance(field, models.GeneratedField):
        return "adds a generated column, which rewrites the whole table under a lock."
    if field.unique or field.db_index:
        return (
            "adds an index or a unique constraint in the same statement as the column, which "
            "builds it under a lock that blocks the table. Add the bare column, then the index "
            "with AddIndexConcurrently in a later migration."
        )
    if field.remote_field and (field.db_constraint or field.db_index):
        return (
            "adds a foreign key with its constraint and index in one statement, which scans "
            "and indexes the table under a lock. Add the column with db_constraint=False and "
            "db_index=False, then the index concurrently and the constraint as not valid."
        )
    return None


def _alters_database(operation, app_label, state):
    """False only when an AlterField provably changes nothing in the database."""
    if state is None:
        return True
    try:
        after = state.clone()
        operation.state_forwards(app_label, after)
        old = state.apps.get_model(app_label, operation.model_name)._meta.get_field(operation.name)
        new = after.apps.get_model(app_label, operation.model_name)._meta.get_field(operation.name)
        editor = connection.SchemaEditorClass(connection, collect_sql=True)
        return editor._field_should_be_altered(old, new)
    except Exception:
        return True


def audit(app_label, migration, earlier=(), state=None) -> list[Problem]:
    """Problems with one migration. earlier is [(release, migration)] for the
    app's migrations that precede it; state is the project state before it."""
    problems = []

    def problem(operation, message):
        problems.append(Problem(app_label, migration.name, type(operation).__name__, message))

    shipped_in = getattr(migration, "wax_release", None)
    try:
        release.parse(shipped_in)
    except ValueError:
        problems.append(
            Problem(app_label, migration.name, "wax_release", "must state the MAJOR.MINOR.PATCH release it shipped in")
        )
        return problems

    database, _ = _split(migration.operations)
    created_here = {op.name.lower() for op in database if isinstance(op, migrations.CreateModel)}
    atomic = getattr(migration, "atomic", True)

    unwrapped = [op.operation if isinstance(op, Reviewed) else op for op in database]
    if any(isinstance(op, NON_ATOMIC + (ValidateConstraint,)) for op in unwrapped) and len(database) != 1:
        problems.append(
            Problem(
                app_label, migration.name, "atomic",
                "a concurrent index operation or a constraint validation must be the only "
                "operation in its migration, so that a failure leaves nothing half applied "
                "and no stronger lock is held while it runs.",
            )
        )

    for operation in database:
        reviewed = isinstance(operation, Reviewed)
        inner = operation.operation if reviewed else operation

        if isinstance(inner, STATE_ONLY):
            problem(
                inner,
                "can only run while the previous release still uses what it removes. In this "
                "release make it a state-only change (SeparateDatabaseAndState). In a later "
                "release drop it with wax.migration_operations.DropColumn or DropTable.",
            )
        elif isinstance(inner, DropColumn | DropTable):
            if isinstance(inner, DropColumn):
                model, field = inner.model_name.lower(), inner.field_name
                since = _stopped_using(
                    earlier,
                    lambda op: isinstance(op, migrations.RemoveField)
                    and op.model_name.lower() == model and op.name == field,
                )
            else:
                model = inner.model_name.lower()
                since = _stopped_using(
                    earlier, lambda op: isinstance(op, migrations.DeleteModel) and op.name.lower() == model
                )
            if since is None:
                problem(inner, "no earlier migration made the matching state-only removal.")
            elif release.minor(since) >= release.minor(shipped_in):
                problem(
                    inner,
                    f"the code stopped using this in {since}, which is not an earlier release "
                    f"than {shipped_in}. The previous release still reads and writes it.",
                )
        elif isinstance(inner, UNQUALIFIED):
            problem(inner, "does nothing on a schema-qualified table. Use wax.migration_operations.DropIndex.")
        elif isinstance(inner, NON_ATOMIC):
            if atomic:
                problem(inner, "runs CONCURRENTLY, which PostgreSQL refuses inside a transaction. Set atomic = False.")
        elif isinstance(inner, migrations.AddIndex):
            if inner.model_name.lower() not in created_here:
                problem(
                    inner,
                    "builds an index on an existing table under a lock that blocks writes. "
                    "Use AddIndexConcurrently in its own migration with atomic = False.",
                )
        elif isinstance(inner, migrations.AddConstraint) and inner.model_name.lower() in created_here:
            pass  # a constraint on a table this migration creates locks nothing anyone uses
        elif isinstance(inner, migrations.AddField):
            message = None if inner.model_name.lower() in created_here else _add_field_problem(inner)
            if message and not reviewed:
                problem(inner, message)
        elif isinstance(inner, SAFE):
            pass
        elif isinstance(inner, migrations.AlterField) and not _alters_database(inner, app_label, state):
            pass
        elif not reviewed:
            problem(
                inner,
                "cannot be proven safe for the previous release by this check. Review it "
                "against SHARED-0010 and wrap it in wax.migration_operations.Reviewed with a reason.",
            )

        if reviewed and not str(operation.reason).strip():
            problem(inner, "Reviewed needs a reason.")
        if state is not None:
            try:
                operation.state_forwards(app_label, state)
            except Exception:
                state = None
    return problems


def audit_all(loader, baseline) -> list[Problem]:
    """Every first-party migration that is not part of the pre-release baseline."""
    problems = []
    by_app = {}
    for (app_label, name), migration in sorted(loader.disk_migrations.items()):
        if type(migration).__module__.startswith("django."):
            continue
        by_app.setdefault(app_label, []).append((name, migration))
    for app_label, items in by_app.items():
        earlier = []
        for name, migration in items:
            if (app_label, name) in baseline:
                earlier.append((BASELINE_RELEASE, migration))
                continue
            try:
                state = loader.project_state((app_label, name), at_end=False)
            except Exception:
                state = None
            problems.extend(audit(app_label, migration, earlier, state))
            earlier.append((getattr(migration, "wax_release", None) or BASELINE_RELEASE, migration))
            component = release.component_for_app(app_label)
            shipped_in = getattr(migration, "wax_release", None)
            try:
                ahead = component and release.parse(shipped_in) > release.parse(component.release)
            except ValueError:
                ahead = False
            if ahead:
                problems.append(
                    Problem(app_label, name, "wax_release", f"{shipped_in} is later than {component.name} {component.release}")
                )
    return problems
