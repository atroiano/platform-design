import re

from django.conf import settings
from django.db import connection

from wax.smoke import probe


@probe("read_model_matches_books")
def read_model_matches_books(sample=50):
    """For recently changed accounts whose summary has caught up with their
    own event stream, the summary's balance must equal the bucket rows."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT summary.account_summary_read_model_pk, summary.balance_minor_units,
                   (SELECT coalesce(sum(bucket.balance_minor_units), 0)
                      FROM ar.account_balance_bucket bucket
                     WHERE bucket.account_fk = summary.account_summary_read_model_pk)
              FROM ar.account_summary_read_model summary
             WHERE summary.last_global_sequence_number =
                   (SELECT max(event.global_sequence_number) FROM core.event event
                     WHERE event.aggregate_pk_ref = summary.account_summary_read_model_pk)
             ORDER BY summary.last_global_sequence_number DESC
             LIMIT %s
            """,
            [sample],
        )
        rows = cursor.fetchall()
    wrong = [str(pk) for pk, shown, owed in rows if shown != owed]
    if wrong:
        raise RuntimeError(f"{len(wrong)} of {len(rows)} summaries disagree with the books: {wrong[:3]}")
    return f"{len(rows)} accounts"


@probe("frontend_and_docs_are_servable")
def frontend_and_docs_are_servable():
    """An image built without its frontend, or without the documentation
    page's assets, would otherwise pass every other check and be cut over to."""
    index = settings.FRONTEND_DIST / "index.html"
    if not index.exists():
        raise RuntimeError("this image has no built frontend")
    entry = re.search(r'src="/(assets/[^"]+\.js)"', index.read_text())
    if not entry or not (settings.FRONTEND_DIST / entry.group(1)).exists():
        raise RuntimeError("the frontend's entry script is missing from this image")
    if not (settings.STATIC_ROOT / "ninja" / "swagger-ui-bundle.js").exists():
        raise RuntimeError("the API documentation page's assets are missing from this image")
    return entry.group(1)
