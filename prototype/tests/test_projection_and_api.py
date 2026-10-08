import json

import pytest
from django.conf import settings
from django.test import Client

from wax import projections

KEY = {"HTTP_X_API_KEY": settings.HIVEAR_DEV_API_KEY}


def call(client, name, body):
    response = client.post(
        f"/api/v1/commands/{name}", data=json.dumps(body), content_type="application/json", **KEY
    )
    return response.status_code, response.json()


# Real commits: the projection reader only sees committed transactions.
@pytest.mark.django_db(transaction=True)
def test_api_write_then_projected_read(buckets):
    client = Client()
    assert client.post("/api/v1/commands/place-account", data="{}", content_type="application/json").status_code == 401

    status, placed = call(client, "place-account", {
        "client_account_number": "A-1001", "debt_type": "personal_loan",
        "contract_type": "purchase", "currency_code": "USD", "list_date": "2026-02-01",
        "itemization_date": "2025-12-31", "opening_balances": {"principal": 150000, "interest": 2500},
    })
    assert status == 202
    account_pk = placed["account_pk"]

    status, _ = call(client, "post-payment", {
        "account_pks": [account_pk], "amount_minor_units": 50000, "currency_code": "USD",
    })
    assert status == 202
    status, body = call(client, "post-payment", {
        "account_pks": [account_pk], "amount_minor_units": 100, "currency_code": "EUR",
    })
    assert status == 422 and "EUR" in body["detail"]

    while projections.run_once():
        pass

    summary = client.get(f"/api/v1/accounts/{account_pk}", **KEY).json()
    assert summary["balance_minor_units"] == 102500
    assert summary["balance_buckets"] == {"principal": 102500, "interest": 0}
    payments = client.get(f"/api/v1/accounts/{account_pk}/payments", **KEY).json()
    assert [line["applied_minor_units"] for line in payments["items"]] == [50000]

    history = client.get(f"/api/v1/accounts/{account_pk}/history", **KEY).json()["items"]
    assert [event["event_type"] for event in history] == ["account.payment_applied", "account.placed"]
    assert history[0]["prior_event_hash"] == history[1]["event_hash"]
    assert projections.run_once() == 0
