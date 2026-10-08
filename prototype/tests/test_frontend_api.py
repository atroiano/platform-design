"""The endpoints the frontend is built on, the API documentation page, and
the inputs a browser or a script could send by mistake."""

import json
import re
import uuid

import pytest
from django.conf import settings
from django.test import Client

from hivear import commands
from tests.conftest import ACTOR
from wax import projections
from wax.commands import dispatch

KEY = {"HTTP_X_API_KEY": settings.HIVEAR_DEV_API_KEY}
ACCOUNT = {
    "debt_type": "personal_loan", "contract_type": "third_party_contingency", "currency_code": "USD",
    "list_date": "2026-02-01", "itemization_date": "2025-12-31",
}


def post(client, name, body):
    response = client.post(f"/api/v1/commands/{name}", data=json.dumps(body), content_type="application/json", **KEY)
    return response.status_code, response.json()


def get(client, path):
    response = client.get(f"/api/v1{path}", **KEY)
    return response.status_code, response.json()


def place(client, number, **balances):
    status, body = post(client, "place-account", {
        **ACCOUNT, "client_account_number": number,
        "opening_balances": balances or {"principal": 100_000, "interest": 5_000},
    })
    assert status == 202, body
    return body


def settle(client, position):
    while projections.run_once():
        pass
    reached = get(client, "/position")[1]
    assert reached["position"] >= position and reached["stopped"] == []


@pytest.mark.django_db(transaction=True)
def test_what_the_screens_read(buckets):
    client = Client()
    first = place(client, "FE-1001")
    second = place(client, "FE-2002", principal=40_000)
    status, paid = post(client, "post-payment", {
        "account_pks": [first["account_pk"], second["account_pk"]], "amount_minor_units": 150_000,
        "currency_code": "USD", "allocation_method": "oldest_first",
    })
    assert status == 202 and paid["position"] > second["position"]
    settle(client, paid["position"])

    # The list, with search.
    _, listing = get(client, "/accounts?search=fe-10")
    assert listing["total"] == 1
    account = listing["items"][0]
    assert account["account_pk"] == first["account_pk"] and account["debt_type"] == "personal_loan"
    assert account["list_date"] == "2026-02-01" and account["balance_minor_units"] == 0
    assert get(client, "/accounts?limit=1")[1]["total"] >= 2

    # The receipt: each account the payment was taken against, and what was left over.
    _, receipt = get(client, f"/payments/{paid['payment_pk']}")
    by_number = {a["client_account_number"]: a for a in receipt["accounts"]}
    assert by_number["FE-1001"]["bucket_amounts"] == {"interest": 5_000, "principal": 100_000}
    assert by_number["FE-2002"]["applied_minor_units"] == 40_000
    assert receipt["unapplied_minor_units"] == 5_000 and receipt["status"] == "posted"

    # One account's payments, then the reversal showing on both.
    _, lines = get(client, f"/accounts/{second['account_pk']}/payments")
    assert lines["total"] == 1
    line = lines["items"][0]
    assert (line["applied_minor_units"], line["payment_amount_minor_units"], line["payment_unapplied_minor_units"], line["status"]) == (40_000, 150_000, 5_000, "applied")
    status, reversed_ = post(client, "reverse-payment", {"payment_pk": paid["payment_pk"]})
    settle(client, reversed_["position"])
    assert get(client, f"/accounts/{first['account_pk']}/payments")[1]["items"][0]["status"] == "reversed"
    assert get(client, f"/payments/{paid['payment_pk']}")[1]["status"] == "reversed"
    assert get(client, f"/accounts/{first['account_pk']}")[1]["balance_minor_units"] == 105_000

    # History is newest first, carries the reason, pages, and serves accounts only.
    _, history = get(client, f"/accounts/{first['account_pk']}/history")
    assert history["total"] == 3
    assert [(e["event_type"], e["reason"]) for e in history["items"]] == [
        ("account.payment_reversed", "Payment returned"),
        ("account.payment_applied", "Payment received"),
        ("account.placed", "Account placed"),
    ]
    _, page = get(client, f"/accounts/{first['account_pk']}/history?limit=1&offset=2")
    assert [e["event_type"] for e in page["items"]] == ["account.placed"] and page["total"] == 3
    assert get(client, f"/accounts/{paid['payment_pk']}/history")[0] == 404

    assert [d["code"] for d in get(client, "/bucket-definitions")[1]] == ["interest", "fee", "principal"]
    assert {"code": "JPY", "minor_unit_digits": 0} in get(client, "/currencies")[1]


@pytest.mark.django_db(transaction=True)
def test_money_held_unapplied_can_always_be_found_again(buckets):
    """A payment that applied nothing used to appear on no screen once its
    receipt was closed, and so could not be reversed."""
    client = Client()
    account = place(client, "FE-DISPUTED")
    post(client, "open-dispute", {"account_pk": account["account_pk"]})
    status, paid = post(client, "post-payment", {
        "account_pks": [account["account_pk"]], "amount_minor_units": 5_000, "currency_code": "USD",
    })
    settle(client, paid["position"])

    _, lines = get(client, f"/accounts/{account['account_pk']}/payments")
    (line,) = lines["items"]
    assert (line["status"], line["applied_minor_units"], line["payment_unapplied_minor_units"]) == ("held", 0, 5_000)
    _, receipt = get(client, f"/payments/{paid['payment_pk']}")
    assert receipt["accounts"][0]["client_account_number"] == "FE-DISPUTED" and receipt["unapplied_minor_units"] == 5_000

    status, reversed_ = post(client, "reverse-payment", {"payment_pk": line["payment_pk"]})
    assert status == 202
    settle(client, reversed_["position"])
    assert get(client, f"/accounts/{account['account_pk']}/payments")[1]["items"][0]["status"] == "reversed"

    # The event says what was asked, so the trail shows no direction was given.
    posted = [e for e in __import__("wax").store.load_stream(uuid.UUID(paid["payment_pk"]))][0]
    assert posted.new_value["request"]["account_pks"] == [account["account_pk"]]
    assert posted.new_value["request"]["directed_allocations"] == {}


@pytest.mark.django_db(transaction=True)
def test_a_retry_after_a_lost_response_is_the_same_payment(buckets):
    client = Client()
    account = place(client, "FE-RETRY", principal=10_000)
    body = {
        "payment_pk": str(uuid.uuid4()), "account_pks": [account["account_pk"]],
        "amount_minor_units": 2_500, "currency_code": "USD",
    }
    status, first = post(client, "post-payment", body)
    status_again, again = post(client, "post-payment", body)
    assert (status, status_again) == (202, 202) and again["position"] >= first["position"]
    settle(client, again["position"])
    assert get(client, f"/accounts/{account['account_pk']}")[1]["balance_minor_units"] == 7_500
    assert get(client, f"/accounts/{account['account_pk']}/payments")[1]["total"] == 1

    # The same key with different contents is a different payment, and is refused.
    assert post(client, "post-payment", {**body, "amount_minor_units": 9_999})[0] == 422
    # Placing is the same.
    placed = {**ACCOUNT, "account_pk": account["account_pk"], "client_account_number": "FE-RETRY", "opening_balances": {"principal": 10_000}}
    assert post(client, "place-account", placed)[0] == 202
    assert post(client, "place-account", {**placed, "client_account_number": "SOMETHING-ELSE"})[0] == 422


@pytest.mark.django_db
def test_the_api_documentation_page_and_schema_are_served():
    client = Client()
    docs = client.get("/api/v1/docs")
    assert docs.status_code == 200 and b"swagger" in docs.content.lower()
    schema = client.get("/api/v1/openapi.json").json()
    assert "/api/v1/accounts" in schema["paths"]
    # Every response the frontend reads has a declared shape, and what it
    # branches on is a closed set the build checks.
    for path, methods in schema["paths"].items():
        for method, operation in methods.items():
            ok = operation["responses"].get("200") or operation["responses"].get("202")
            assert "content" in ok, f"{method} {path} has no response schema"
    assert schema["components"]["schemas"]["PaymentLineOut"]["properties"]["status"]["enum"] == ["applied", "held", "reversed"]


@pytest.mark.django_db
def test_inputs_a_browser_or_a_script_could_send_by_mistake_are_refused_cleanly(buckets):
    """Each of these used to be a server error, or was accepted and then
    broke every screen that later read it."""
    client = Client()
    base = {**ACCOUNT, "client_account_number": "FE-BAD"}
    one = {"principal": 1}
    for balances in ({"principal": 10**30}, {"principal": "100"}, {"principal": 1.5}, {"principal": True}, {"principal": 0}, {"prin\u0000cipal": 1}):
        assert post(client, "place-account", {**base, "opening_balances": balances})[0] == 422, balances
    for change in ({"client_account_number": "x\u0000y"}, {"currency_code": "ZZZ"}, {"list_date": 0}, {"list_date": "0001-01-01"}):
        assert post(client, "place-account", {**base, "opening_balances": one, **change})[0] == 422, change
    status, placed = post(client, "place-account", {**base, "opening_balances": one})
    assert status == 202

    payment = {"account_pks": [placed["account_pk"]], "amount_minor_units": 1, "currency_code": "USD"}
    for received_at in ("0001-01-01T00:00:00+01:00", "9999-12-31T23:59:59-05:00", "2026-01-01T00:00:00", "2999-01-01T00:00:00Z"):
        assert post(client, "post-payment", {**payment, "received_at": received_at})[0] == 422, received_at
    assert post(client, "post-payment", {**payment, "received_at": "2026-01-01T09:00:00-05:00"})[0] == 202

    for query in ("offset=9223372036854775808", "offset=-1", "limit=0", "limit=100000", "search=%00"):
        assert client.get(f"/api/v1/accounts?{query}", **KEY).status_code == 422, query
    assert client.get(f"/api/v1/accounts/{placed['account_pk']}/history?offset=99999999999999999999999999999", **KEY).status_code == 422


@pytest.mark.django_db
def test_responses_carry_the_headers_a_page_with_account_data_needs():
    client = Client()
    api = client.get("/api/v1/accounts", **KEY)
    assert api.headers["Cache-Control"] == "no-store"
    assert api.headers["X-Frame-Options"] == "DENY"
    assert "frame-ancestors 'none'" in api.headers["Content-Security-Policy"]
    assert "script-src 'self'" in api.headers["Content-Security-Policy"]
    assert "Content-Security-Policy" not in client.get("/api/v1/docs").headers


@pytest.mark.django_db
def test_only_a_page_address_gets_the_application_shell():
    client = Client()
    built = (settings.FRONTEND_DIST / "index.html").exists()
    page = client.get("/accounts/3f0c2a0e-0000-4000-8000-000000000000")
    assert page.status_code == (200 if built else 404)
    if built:
        assert page.headers["Cache-Control"] == "no-cache"
        assert client.get("/").status_code == 200
        # Every script the shell names is really in the image.
        for asset in re.findall(r'src="(/assets/[^"]+)"', page.content.decode()):
            assert (settings.FRONTEND_DIST / asset.lstrip("/")).exists(), asset
    # A mistyped command, a missing file, and a near-miss of the API prefix are not pages.
    assert client.post("/commands/post-payment", data="{}", content_type="application/json").status_code == 405
    assert client.get("/missing.js").status_code == 404
    assert client.get("/api").status_code == 404
    assert client.get("/API/v1/accounts").status_code == 404
    assert client.get("/api/v1/nope").status_code == 404


@pytest.mark.django_db
def test_the_smoke_check_requires_what_the_image_must_serve():
    from hivear.smoke import frontend_and_docs_are_servable

    if (settings.FRONTEND_DIST / "index.html").exists():
        assert frontend_and_docs_are_servable().startswith("assets/")
    else:
        with pytest.raises(RuntimeError, match="no built frontend"):
            frontend_and_docs_are_servable()


@pytest.mark.django_db
def test_a_repeated_command_through_the_dispatcher_writes_nothing(buckets):
    command = commands.PlaceAccount(
        client_account_number="FE-TWICE", debt_type="personal_loan", contract_type="purchase",
        currency_code="USD", list_date="2026-02-01", itemization_date="2025-12-31",
        opening_balances={"principal": 500},
    )
    first = dispatch(command, actor_pk=ACTOR)
    again = dispatch(command, actor_pk=ACTOR)
    from wax import store

    assert again >= first and store.load_stream(command.account_pk).count() == 1


@pytest.mark.django_db(transaction=True)
def test_every_payment_is_listed_and_held_money_can_be_filtered_for(buckets):
    client = Client()
    account = place(client, "FE-LIST", principal=1_000)
    _, exact = post(client, "post-payment", {"account_pks": [account["account_pk"]], "amount_minor_units": 400, "currency_code": "USD"})
    _, over = post(client, "post-payment", {"account_pks": [account["account_pk"]], "amount_minor_units": 900, "currency_code": "USD"})
    settle(client, over["position"])

    _, everything = get(client, "/payments")
    assert {exact["payment_pk"], over["payment_pk"]} <= {p["payment_pk"] for p in everything["items"]}
    _, held = get(client, "/payments?held=true")
    mine = [p for p in held["items"] if p["payment_pk"] in (exact["payment_pk"], over["payment_pk"])]
    assert [(p["payment_pk"], p["unapplied_minor_units"]) for p in mine] == [(over["payment_pk"], 300)]

    # Once reversed it no longer holds anything.
    _, reversed_ = post(client, "reverse-payment", {"payment_pk": over["payment_pk"]})
    settle(client, reversed_["position"])
    assert over["payment_pk"] not in {p["payment_pk"] for p in get(client, "/payments?held=true")[1]["items"]}


@pytest.mark.django_db
def test_bucket_amounts_on_a_disputed_account_need_the_consumers_direction_from_every_caller(buckets):
    """The form asks the question. The server asks it of everyone else."""
    client = Client()
    account = place(client, "FE-DIRECT", principal=10_000)
    post(client, "open-dispute", {"account_pk": account["account_pk"]})
    payment = {
        "account_pks": [account["account_pk"]], "amount_minor_units": 500, "currency_code": "USD",
        "bucket_amounts": {account["account_pk"]: {"principal": 500}},
    }
    status, refused = post(client, "post-payment", payment)
    assert (status, refused["code"]) == (422, "dispute_needs_direction")
    status, _ = post(client, "post-payment", {**payment, "consumer_directed_accounts": [account["account_pk"]]})
    assert status == 202
    # The statement is permanent, so it may only be made about an account whose bucket amounts the payment carries.
    stray = {"account_pks": [account["account_pk"]], "amount_minor_units": 1, "currency_code": "USD", "consumer_directed_accounts": [account["account_pk"]]}
    status, refused = post(client, "post-payment", stray)
    assert (status, refused["code"]) == (422, "direction_off_payment")
    from tests.conftest import balances

    assert balances(account["account_pk"]) == {"principal": 9_500}


@pytest.mark.django_db
def test_a_refusal_names_itself_so_a_client_can_put_it_in_its_own_words(buckets):
    client = Client()
    account = place(client, "FE-CODES", principal=10_000)
    _, paid = post(client, "post-payment", {"account_pks": [account["account_pk"]], "amount_minor_units": 100, "currency_code": "USD"})
    assert post(client, "reverse-payment", {"payment_pk": paid["payment_pk"]})[0] == 202
    status, again = post(client, "reverse-payment", {"payment_pk": paid["payment_pk"]})
    assert (status, again["code"]) == (422, "payment_not_reversible")
    status, missing = post(client, "post-payment", {"account_pks": [str(uuid.uuid4())], "amount_minor_units": 1, "currency_code": "USD"})
    assert (status, missing["code"]) == (422, "account_not_found")
    refused = client.post("/api/v1/commands/open-dispute", data=json.dumps({"account_pk": account["account_pk"]}), content_type="application/json", SERVER_PORT="8001", **KEY)
    assert (refused.status_code, refused.json()["code"]) == (403, "preview_read_only")


@pytest.mark.django_db
def test_a_retry_of_a_payment_recorded_before_a_request_field_existed_is_still_the_same_payment(buckets):
    from django.db import connection

    from wax import store

    client = Client()
    account = place(client, "FE-OLD", principal=10_000)
    body = {"payment_pk": str(uuid.uuid4()), "account_pks": [account["account_pk"]], "amount_minor_units": 100, "currency_code": "USD"}
    assert post(client, "post-payment", body)[0] == 202
    # Make the recorded event look as it would have before consumer_directed_accounts was added.
    first = store.load_stream(uuid.UUID(body["payment_pk"])).first()
    assert "consumer_directed_accounts" in first.new_value["request"]
    with connection.cursor() as cursor:
        cursor.execute("ALTER TABLE core.event DISABLE TRIGGER trg_event_before_update_or_delete")
        cursor.execute(
            "UPDATE core.event SET new_value = new_value #- '{request,consumer_directed_accounts}' WHERE event_pk = %s",
            [first.event_pk],
        )
        cursor.execute("ALTER TABLE core.event ENABLE TRIGGER trg_event_before_update_or_delete")
    assert post(client, "post-payment", body)[0] == 202
    assert post(client, "post-payment", {**body, "amount_minor_units": 101})[0] == 422
