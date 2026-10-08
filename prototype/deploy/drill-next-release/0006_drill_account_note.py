"""Used only by deploy/drill.sh, which copies it into its second release.

It gives the rehearsal a real schema change to carry across a cutover: a
column added while the previous release is still serving, and still serving
again after the rollback. It is not part of the application.
"""

from django.db import migrations

from wax.migration_operations import Reviewed


class Migration(migrations.Migration):
    wax_release = "0.3.0"
    dependencies = [("hivear", "0005_account_payment_lines")]
    operations = [
        Reviewed(
            migrations.RunSQL(
                "ALTER TABLE ar.account ADD COLUMN drill_note text",
                "ALTER TABLE ar.account DROP COLUMN drill_note",
            ),
            reason="One nullable column. The previous release never names it, so its reads and writes are unchanged.",
        ),
    ]
