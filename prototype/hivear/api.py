"""REST surface (SHARED-0003): one endpoint per command or query, versioned
under /api/v1/. Commands answer 202 with the key of what they created and a
position; reads come from read models, which lag writes briefly, and a caller
that wants to read its own write waits for /position to pass that number.

Every response has a declared schema, because the frontend's types are
generated from this module's OpenAPI document (SHARED-0009).
"""

import re
from datetime import date, datetime
from typing import Literal
from uuid import UUID, uuid4

from django.conf import settings
from django.utils.crypto import constant_time_compare
from ninja import NinjaAPI, Query, Schema, Status
from ninja.security import APIKeyHeader

from hivear import commands
from hivear.currency import MINOR_UNIT_DIGITS
from hivear.models import AccountPaymentLine, AccountSummaryReadModel, BalanceBucketDefinition, PaymentReadModel
from wax import projections, release, store
from wax.commands import CommandRejected, dispatch


class DevelopmentKey(APIKeyHeader):
    """Placeholder for WAX-0017 and WAX-0018: one key, one fixed actor."""

    param_name = "X-API-Key"

    def authenticate(self, request, key):
        if key and constant_time_compare(key, settings.HIVEAR_DEV_API_KEY):
            return settings.HIVEAR_DEV_ACTOR_PK
        return None


api = NinjaAPI(title="HiveAR draft", version="1", auth=DevelopmentKey())


class Problem(Schema):
    detail: str
    # Names a refusal, so a client can show it in its own words and language.
    code: str = "error"


class FieldProblem(Schema):
    type: str
    loc: list[str | int]
    msg: str


class ValidationProblem(Schema):
    """What a request that fails validation is answered with."""

    detail: list[FieldProblem]


class ComponentOut(Schema):
    schema_release: str
    minimum_code_release: str
    live_release: str | None


class HealthOut(Schema):
    status: Literal["ok", "incompatible_schema"]
    release: str
    color: Literal["blue", "green"]
    live: bool
    preview: bool
    # The frontend build this color serves, so a page can tell when the build
    # answering is no longer the one it was loaded from.
    frontend_entry: str | None
    components: dict[str, ComponentOut]
    detail: list[str] = []


class PositionOut(Schema):
    position: int
    # Read models that have stopped and will not catch up by themselves.
    stopped: list[str]


class CurrencyOut(Schema):
    code: str
    minor_unit_digits: int


class AccountAccepted(Schema):
    account_pk: UUID
    position: int


class DisputeAccepted(Schema):
    dispute_pk: UUID
    position: int


class PaymentAccepted(Schema):
    payment_pk: UUID
    position: int


class BucketDefinitionOut(Schema):
    code: str
    label: str
    waterfall_priority: int


class AccountOut(Schema):
    account_pk: UUID
    client_account_number: str
    status: str
    is_disputed: bool
    currency_code: str
    debt_type: str | None
    contract_type: str | None
    list_date: date | None
    balance_minor_units: int
    balance_buckets: dict[str, int]
    last_global_sequence_number: int

    @staticmethod
    def resolve_account_pk(summary):
        return summary.account_summary_read_model_pk


class AccountListOut(Schema):
    items: list[AccountOut]
    total: int


PaymentLineStatus = Literal["applied", "held", "reversed"]


class PaymentLineOut(Schema):
    """One payment as one account saw it."""

    payment_pk: UUID
    account_pk: UUID
    applied_minor_units: int
    bucket_amounts: dict[str, int]
    payment_amount_minor_units: int
    payment_unapplied_minor_units: int
    currency_code: str
    received_at: datetime
    status: PaymentLineStatus


class PaymentLineListOut(Schema):
    items: list[PaymentLineOut]
    total: int


class ReceiptAccountOut(Schema):
    account_pk: UUID
    client_account_number: str | None
    applied_minor_units: int
    bucket_amounts: dict[str, int]


class PaymentReceiptOut(Schema):
    payment_pk: UUID
    amount_minor_units: int
    currency_code: str
    status: Literal["posted", "reversed"]
    received_at: datetime
    # Every account the payment was taken against, including any that received nothing.
    accounts: list[ReceiptAccountOut]
    unapplied_minor_units: int


class PaymentSummaryOut(Schema):
    payment_pk: UUID
    amount_minor_units: int
    currency_code: str
    status: Literal["posted", "reversed"]
    received_at: datetime
    unapplied_minor_units: int

    @staticmethod
    def resolve_payment_pk(payment):
        return payment.payment_read_model_pk


class PaymentListOut(Schema):
    items: list[PaymentSummaryOut]
    total: int


class EventOut(Schema):
    aggregate_sequence_number: int
    global_sequence_number: int
    event_type: str
    occurred_at: datetime
    recorded_at: datetime
    actor_pk_ref: UUID
    actor_type: str
    reason: str | None
    source: str | None
    prior_value: dict | None
    new_value: dict | None
    metadata: dict | None
    prior_event_hash: str | None
    event_hash: str


class HistoryOut(Schema):
    # Newest first.
    items: list[EventOut]
    total: int


@api.exception_handler(CommandRejected)
def _rejected(request, exc):
    return api.create_response(request, {"detail": str(exc), "code": exc.code}, status=422)


@api.exception_handler(store.ConcurrencyError)
def _conflict(request, exc):
    return api.create_response(request, {"detail": "Concurrent update; retry", "code": "conflict"}, status=409)


@api.exception_handler(release.IncompatibleSchema)
def _incompatible(request, exc):
    return api.create_response(request, {"detail": str(exc), "code": "incompatible_schema"}, status=503)


class PreviewIsReadOnly(Exception):
    pass


@api.exception_handler(PreviewIsReadOnly)
def _preview(request, exc):
    return api.create_response(
        request,
        {"detail": "The preview port is read-only. Commands go through the live port.", "code": "preview_read_only"},
        status=403,
    )


def _is_preview(request) -> bool:
    """True for a request that arrived on the application's preview listener.
    The port is set by the socket the request came in on, so nothing a client
    sends can change it (SHARED-0010)."""
    return request.META.get("SERVER_PORT") == settings.PREVIEW_PORT


def _run(request, command) -> int:
    # A color under test must not write to the live database.
    if _is_preview(request):
        raise PreviewIsReadOnly()
    return dispatch(
        command,
        actor_pk=request.auth,
        source="api",
        correlation_pk=uuid4(),
        correlation_type="api_request",
    )


KEYED = {401: Problem}
COMMAND_ERRORS = {**KEYED, 403: Problem, 409: Problem, 422: Problem | ValidationProblem, 503: Problem}
Limit = Query(50, ge=1, le=200)
Offset = Query(0, ge=0, le=2_000_000_000)
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def _frontend_entry() -> str | None:
    index = settings.FRONTEND_DIST / "index.html"
    if not index.exists():
        return None
    match = re.search(r'src="(/assets/[^"]+\.js)"', index.read_text())
    return match.group(1) if match else None


@api.get("/health", auth=None, response={200: HealthOut, 503: HealthOut})
def health(request):
    """Which release and color answered, and whether it is the live one.
    The release tooling and the frontend read this (SHARED-0010). A release
    the database has moved past answers 503 so that it is never switched in."""
    problems = release.incompatibilities()
    body = {
        "status": "incompatible_schema" if problems else "ok",
        "release": release.RELEASE,
        "color": release.COLOR,
        "live": release.deployment_state()["active_color"] == release.COLOR,
        "preview": _is_preview(request),
        "frontend_entry": _frontend_entry(),
        "components": release.recorded_components(),
        "detail": problems,
    }
    return Status(503 if problems else 200, body)


@api.get("/position", response={200: PositionOut, **KEYED})
def position(request):
    """How far this release's read models have come. Everything a command
    reported at or below this number is now visible to queries. A read model
    that has stopped is named, because the number will not move past it."""
    rows = projections.status()
    return {
        "position": min((row["position"] for row in rows), default=0),
        "stopped": [row["projection"] for row in rows if row["failed_at"] or not row["definition_matches"]],
    }


@api.get("/currencies", response={200: list[CurrencyOut], **KEYED})
def currencies(request):
    """The currencies this installation takes and how many minor-unit digits
    each has. The browser uses these, never its own currency data."""
    return [{"code": code, "minor_unit_digits": digits} for code, digits in sorted(MINOR_UNIT_DIGITS.items())]


@api.get("/bucket-definitions", response={200: list[BucketDefinitionOut], **KEYED})
def bucket_definitions(request):
    return BalanceBucketDefinition.objects.order_by("waterfall_priority", "code")


@api.post("/commands/place-account", response={202: AccountAccepted, **COMMAND_ERRORS})
def place_account(request, command: commands.PlaceAccount):
    return Status(202, {"account_pk": command.account_pk, "position": _run(request, command)})


@api.post("/commands/open-dispute", response={202: DisputeAccepted, **COMMAND_ERRORS})
def open_dispute(request, command: commands.OpenDispute):
    return Status(202, {"dispute_pk": command.dispute_pk, "position": _run(request, command)})


@api.post("/commands/post-payment", response={202: PaymentAccepted, **COMMAND_ERRORS})
def post_payment(request, command: commands.PostPayment):
    return Status(202, {"payment_pk": command.payment_pk, "position": _run(request, command)})


@api.post("/commands/reverse-payment", response={202: PaymentAccepted, **COMMAND_ERRORS})
def reverse_payment(request, command: commands.ReversePayment):
    return Status(202, {"payment_pk": command.payment_pk, "position": _run(request, command)})


@api.get("/accounts", response={200: AccountListOut, 422: Problem | ValidationProblem, **KEYED})
def accounts(request, search: str = Query("", max_length=100), limit: int = Limit, offset: int = Offset):
    """Accounts, newest activity first. search matches the client's account number."""
    if _CONTROL.search(search):
        return Status(422, {"detail": "search contains a control character", "code": "search_invalid"})
    found = AccountSummaryReadModel.objects.all()
    if search.strip():
        found = found.filter(client_account_number__icontains=search.strip())
    page = found.order_by("-last_global_sequence_number")[offset : offset + limit]
    return {"items": list(page), "total": found.count()}


@api.get("/accounts/{account_pk}", response={200: AccountOut, 404: Problem, **KEYED})
def account_summary(request, account_pk: UUID):
    summary = AccountSummaryReadModel.objects.filter(pk=account_pk).first()
    if summary is None:
        return Status(404, {"detail": "Not found, or not projected yet", "code": "not_found"})
    return summary


@api.get("/accounts/{account_pk}/payments", response={200: PaymentLineListOut, 422: ValidationProblem, **KEYED})
def account_payments(request, account_pk: UUID, limit: int = Limit, offset: int = Offset):
    """Every payment taken against the account, newest first, including any
    that applied nothing here."""
    lines = AccountPaymentLine.objects.filter(account_pk=account_pk)
    page = lines.order_by("-received_at", "-payment_pk")[offset : offset + limit]
    return {"items": list(page), "total": lines.count()}


@api.get("/payments", response={200: PaymentListOut, 422: ValidationProblem, **KEYED})
def payments(request, held: bool = False, limit: int = Limit, offset: int = Offset):
    """Every payment, newest first. held=true lists only payments that still
    stand and still hold money unapplied, so that money can always be found
    again, whichever account it was or was not applied to."""
    found = PaymentReadModel.objects.all()
    if held:
        found = found.filter(status="posted", unapplied_minor_units__gt=0)
    # Ordered by things fixed when the payment was recorded, so that a
    # reversal does not move a row between pages.
    page = found.order_by("-received_at", "-payment_read_model_pk")[offset : offset + limit]
    return {"items": list(page), "total": found.count()}


@api.get("/payments/{payment_pk}", response={200: PaymentReceiptOut, 404: Problem, **KEYED})
def payment_receipt(request, payment_pk: UUID):
    """Where one payment went, account by account, and anything left unapplied."""
    found = PaymentReadModel.objects.filter(pk=payment_pk).first()
    if found is None:
        return Status(404, {"detail": "Not found, or not projected yet", "code": "not_found"})
    lines = list(AccountPaymentLine.objects.filter(payment_pk=payment_pk).order_by("account_pk"))
    numbers = dict(
        AccountSummaryReadModel.objects.filter(pk__in=[line.account_pk for line in lines]).values_list(
            "account_summary_read_model_pk", "client_account_number"
        )
    )
    return {
        "payment_pk": found.payment_read_model_pk,
        "amount_minor_units": found.amount_minor_units,
        "currency_code": found.currency_code,
        "status": found.status,
        "received_at": found.received_at,
        "unapplied_minor_units": found.unapplied_minor_units,
        "accounts": [
            {
                "account_pk": line.account_pk,
                "client_account_number": numbers.get(line.account_pk),
                "applied_minor_units": line.applied_minor_units,
                "bucket_amounts": line.bucket_amounts,
            }
            for line in lines
        ],
    }


@api.get("/accounts/{account_pk}/history", response={200: HistoryOut, 404: Problem, 422: ValidationProblem, **KEYED})
def account_history(request, account_pk: UUID, limit: int = Limit, offset: int = Offset):
    """The audit query from WAX-0001: every event for the account, newest
    first, a page at a time. Only an account's stream is served here."""
    stream = store.load_stream(account_pk).filter(aggregate_type="account")
    total = stream.count()
    if total == 0:
        return Status(404, {"detail": "Not found", "code": "not_found"})
    events = list(stream.order_by("-aggregate_sequence_number")[offset : offset + limit])
    labels = dict(store.reason_labels({event.reason_code_fk for event in events if event.reason_code_fk}))
    return {
        "total": total,
        "items": [
            {**{field: getattr(event, field) for field in EventOut.model_fields if field != "reason"},
             "reason": labels.get(event.reason_code_fk)}
            for event in events
        ],
    }
