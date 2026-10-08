from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db.migrations.loader import MigrationLoader

from wax import migration_safety


class Command(BaseCommand):
    help = "Fail if any migration breaks the compatibility rules in SHARED-0010."
    requires_system_checks = []

    def handle(self, *args, **options):
        # No database connection: this runs in CI and before anything is migrated.
        loader = MigrationLoader(None, ignore_no_migrations=True)
        problems = migration_safety.audit_all(loader, set(settings.WAX_MIGRATION_BASELINE))
        for problem in problems:
            self.stderr.write(str(problem))
        if problems:
            raise CommandError(f"{len(problems)} migration compatibility problems")
        self.stdout.write("Migrations are compatible with the previous release")
