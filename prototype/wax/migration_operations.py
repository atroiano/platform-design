"""Migration operations for the rules in SHARED-0010.

Django's own RemoveField and DeleteModel cannot express a two-release
removal: once a release has taken a field out of the models (a state-only
change), the framework no longer knows the column exists. These operations
touch the database only, never CASCADE, and are what the second release uses.
"""

from django.db.migrations.operations.base import Operation


def _quote(schema_editor, name):
    return schema_editor.connection.ops.quote_name(name)


class DropColumn(Operation):
    """Drop a column an earlier release already stopped using."""

    reduces_to_sql = True
    reversible = False

    def __init__(self, model_name, field_name, column=None):
        self.model_name, self.field_name, self.column = model_name, field_name, column or field_name

    def state_forwards(self, app_label, state):
        pass

    def database_forwards(self, app_label, schema_editor, from_state, to_state):
        table = to_state.apps.get_model(app_label, self.model_name)._meta.db_table
        schema_editor.execute(
            f"ALTER TABLE {_quote(schema_editor, table)} DROP COLUMN {_quote(schema_editor, self.column)}"
        )

    def describe(self):
        return f"Drop column {self.column} of {self.model_name}"

    def deconstruct(self):
        return type(self).__name__, [self.model_name, self.field_name], {"column": self.column}


class DropTable(Operation):
    """Drop the table of a model an earlier release already deleted."""

    reduces_to_sql = True
    reversible = False

    def __init__(self, model_name, table):
        self.model_name, self.table = model_name, table

    def state_forwards(self, app_label, state):
        pass

    def database_forwards(self, app_label, schema_editor, from_state, to_state):
        schema_editor.execute(f"DROP TABLE {_quote(schema_editor, self.table)}")

    def describe(self):
        return f"Drop table {self.table}"

    def deconstruct(self):
        return type(self).__name__, [self.model_name, self.table], {}


class DropIndex(Operation):
    """Drop an index by its schema-qualified name, without blocking writes.
    Django's RemoveIndex leaves the schema off and so drops nothing here."""

    reduces_to_sql = True
    reversible = False

    def __init__(self, qualified_name):
        if "." not in qualified_name:
            raise ValueError("DropIndex needs a schema-qualified name such as ar.idx_account_status")
        self.qualified_name = qualified_name

    def state_forwards(self, app_label, state):
        pass

    def database_forwards(self, app_label, schema_editor, from_state, to_state):
        schema, name = self.qualified_name.split(".", 1)
        schema_editor.execute(
            f"DROP INDEX CONCURRENTLY IF EXISTS {_quote(schema_editor, schema)}.{_quote(schema_editor, name)}"
        )

    def describe(self):
        return f"Drop index {self.qualified_name}"

    def deconstruct(self):
        return type(self).__name__, [self.qualified_name], {}


class Reviewed(Operation):
    """Wraps one operation the static check cannot prove safe.

    The reason is for the reviewer: what the previous release does with the
    thing being changed, and why it keeps working.
    """

    def __init__(self, operation, reason):
        self.operation, self.reason = operation, reason

    reduces_to_sql = property(lambda self: self.operation.reduces_to_sql)
    reversible = property(lambda self: self.operation.reversible)
    atomic = property(lambda self: self.operation.atomic)
    elidable = property(lambda self: self.operation.elidable)

    def state_forwards(self, app_label, state):
        self.operation.state_forwards(app_label, state)

    def database_forwards(self, app_label, schema_editor, from_state, to_state):
        self.operation.database_forwards(app_label, schema_editor, from_state, to_state)

    def database_backwards(self, app_label, schema_editor, from_state, to_state):
        self.operation.database_backwards(app_label, schema_editor, from_state, to_state)

    def describe(self):
        return f"{self.operation.describe()} (reviewed: {self.reason})"

    def deconstruct(self):
        return type(self).__name__, [self.operation], {"reason": self.reason}
