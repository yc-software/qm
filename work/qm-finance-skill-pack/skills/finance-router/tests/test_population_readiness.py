import importlib.util
from pathlib import Path

import pytest

BASELINE = (
    "Provide the receipts for 2026-10-12 to 2026-10-18, inclusive, "
    "and the outstanding receivables as of 2026-10-19, including migrated SAP invoices."
)


def load_router():
    script = Path(__file__).parents[1] / "scripts" / "atomic_fetch.py"
    spec = importlib.util.spec_from_file_location("finance_router", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_baseline_resolves_ar_populations_and_runbook():
    result = load_router().route(BASELINE)
    assert result["matched_workflow"] == "receipts_and_outstanding_ar"
    assert [population["id"] for population in result["populations"]] == [
        "native_outstanding",
        "sap_migrated_pending",
        "receipts",
        "unapplied_receipts",
        "customer_advances",
    ]
    assert result["recommended_runbook"]["id"] == "ar_receipts_and_outstanding"
    assert result["ready_to_execute"] is False
    assert result["unresolved_items"] == [
        {
            "reason": "missing_required_scope",
            "slots": [
                "entity",
                "subsidiary_scope",
                "currency_basis",
                "accounting_book",
                "comparison_basis",
                "reporting_timezone",
            ],
        }
    ]


@pytest.mark.parametrize(
    "query",
    [
        "Prepare the AR report for receipts 2026-10-27 to 2026-11-02 and as-of 2026-11-02.",
        "Build the accounts receivable report for 2026-10-27 to 2026-11-02 as of 2026-11-02.",
        "Prepare the collection tracker for receipts and open invoices from 2026-10-27 to 2026-11-02 as of 2026-11-02.",
    ],
)
def test_canonical_ar_aliases_select_one_route(query):
    result = load_router().route(query)
    assert result["matched_workflow"] == "receipts_and_outstanding_ar"
    assert result["recommended_runbook"]["id"] == "ar_receipts_and_outstanding"
    assert len(result["populations"]) == 5


def test_explicit_scope_enables_ready_route():
    result = load_router().route(
        BASELINE
        + " Use entity ACME, subsidiary consolidated, currency INR, accounting book primary, no comparison, and reporting timezone Asia/Kolkata."
    )
    slots = result["recommended_runbook"]["resolved_slots"]
    assert slots["entity"] == "ACME"
    assert slots["subsidiary_scope"] == "consolidated"
    assert slots["currency_basis"] == "INR"
    assert slots["accounting_book"] == "primary"
    assert slots["comparison_basis"] == "none"
    assert slots["reporting_timezone"] == "Asia/Kolkata"


def test_dates_are_resolved_by_semantic_labels():
    result = load_router().route(
        "Prepare the accounts receivable report for receipts from 2026-10-01 through 2026-10-31 and AR as of 2026-10-31."
    )
    slots = result["recommended_runbook"]["resolved_slots"]
    assert slots["receipt_start"] == "2026-10-01"
    assert slots["receipt_end"] == "2026-10-31"
    assert slots["as_of"] == "2026-10-31"


def test_single_aging_date_does_not_invent_receipt_window():
    result = load_router().route("Prepare AR aging as of 2026-10-31")
    slots = result["recommended_runbook"]["resolved_slots"]
    assert slots["as_of"] == "2026-10-31"
    assert "receipt_start" not in slots
    assert "receipt_end" not in slots
    assert result["ready_to_execute"] is False


def test_unknown_intent_is_not_ready():
    result = load_router().route("Explain an unrelated request")
    assert result["matched_workflow"] is None
    assert result["ready_to_execute"] is False
    assert result["recommended_runbook"] is None


def test_short_substrings_do_not_override_ar_route():
    result = load_router().route(
        "Prepare the AR report status for receipts from 2026-10-27 to 2026-11-02 as of 2026-11-02"
    )
    assert result["matched_workflow"] == "receipts_and_outstanding_ar"
    assert result["recommended_runbook"]["id"] == "ar_receipts_and_outstanding"
    assert "po_status" not in result["detected_intents"]
