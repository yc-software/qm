import json
import re
import sys
from pathlib import Path

import yaml

REFERENCES = Path(__file__).resolve().parent.parent / "references"
ROUTES_PATH = REFERENCES / "finance-routes.yaml"
RUNBOOKS_PATH = REFERENCES / "runbooks.yaml"


def words(value):
    return tuple(re.findall(r"[a-z0-9]+", value.casefold()))


def contains_phrase(haystack, phrase):
    needle = words(str(phrase))
    return bool(needle) and any(haystack[index : index + len(needle)] == needle for index in range(len(haystack) - len(needle) + 1))


def load_yaml(path):
    return yaml.safe_load(path.read_text()) or {}


def matched_workflow(query):
    query_words = words(query)
    matches = []
    for workflow in load_yaml(ROUTES_PATH).get("workflows") or []:
        for alias in workflow.get("aliases") or []:
            if contains_phrase(query_words, alias):
                matches.append((len(words(str(alias))), workflow))
    return max(matches, default=(0, None), key=lambda row: row[0])[1]


def detected_intents(query, workflow):
    return [workflow["id"]] if workflow else []


def date_slots(query):
    slots = {}
    receipt_range = re.search(
        r"(?:receipt(?:s|\s+window)?|collection(?:s|\s+window)?)\D{0,24}(\d{4}-\d{2}-\d{2})\D{1,24}(\d{4}-\d{2}-\d{2})",
        query,
        re.I,
    )
    cutoff = re.search(r"(?:as\s+of|cutoff)\D{0,12}(\d{4}-\d{2}-\d{2})", query, re.I)
    if receipt_range:
        slots["receipt_start"], slots["receipt_end"] = receipt_range.groups()
    if cutoff:
        slots["as_of"] = cutoff.group(1)
    if "as_of" in slots:
        slots["as_of_compact"] = slots["as_of"].replace("-", "")
    return slots


def scope_slots(query):
    patterns = {
        "entity": r"\b(?:legal\s+entity|entity(?:\s+scope)?)\s*(?:=|:|is)?\s+([A-Za-z0-9][A-Za-z0-9._-]*)",
        "subsidiary_scope": r"\bsubsidiary(?:\s+scope)?\s*(?:=|:|is)?\s+([A-Za-z0-9][A-Za-z0-9._-]*)",
        "currency_basis": r"\bcurrency(?:\s+basis)?\s*(?:=|:|is)?\s+([A-Z]{3})",
        "accounting_book": r"\baccounting\s+book\s*(?:=|:|is)?\s+([A-Za-z0-9][A-Za-z0-9._-]*)",
        "reporting_timezone": r"\b(?:reporting\s+)?timezone\s*(?:=|:|is)?\s+([A-Za-z_]+(?:/[A-Za-z_]+)?)",
    }
    slots = {}
    for key, pattern in patterns.items():
        match = re.search(pattern, query, re.I if key != "currency_basis" else 0)
        if match:
            slots[key] = match.group(1).strip(" .,;")
    if "subsidiary_scope" not in slots and re.search(r"\bconsolidated\b", query, re.I):
        slots["subsidiary_scope"] = "consolidated"
    slots["comparison_basis"] = "none" if re.search(r"\bno\s+comparison\b", query, re.I) else slots.get("comparison_basis")
    return {key: value for key, value in slots.items() if value}


def resolve_runbook(intents, query):
    best = None
    best_score = 0
    for runbook in load_yaml(RUNBOOKS_PATH).get("runbooks") or []:
        score = len(set(runbook.get("intents") or []) & set(intents))
        if score > best_score:
            best = runbook
            best_score = score
    if best is None:
        return None, "no runbook registered for these intents"
    slots = {**(best.get("scope_defaults") or {}), **date_slots(query), **scope_slots(query)}
    missing = [slot for slot in best.get("requires_slots") or [] if slot not in slots]
    resolved = dict(best)
    resolved["resolved_slots"] = slots
    resolved["missing_slots"] = missing
    return resolved, None


def populations_for(workflow):
    populations = []
    unresolved = []
    if not workflow:
        return populations, unresolved
    skill_root = REFERENCES.parents[1]
    for population in workflow.get("populations") or []:
        assets = population.get("required_assets") or []
        missing = []
        for asset in assets:
            skill = str(asset.get("skill") or "").strip()
            file = str(asset.get("file") or "").strip()
            if not skill or not file or not (skill_root / skill / file).is_file():
                missing.append({"skill": skill, "file": file})
        populations.append({"id": population["id"], "status": "blocked" if missing else "resolved", "missing_assets": missing})
        if missing:
            unresolved.append({"population": population["id"], "reason": "incomplete_required_asset_route", "missing_assets": missing})
    return populations, unresolved


def route(query):
    workflow = matched_workflow(query)
    intents = detected_intents(query, workflow)
    populations, unresolved = populations_for(workflow)
    runbook, runbook_error = resolve_runbook(intents, query)
    if runbook and runbook.get("missing_slots"):
        unresolved.append({"reason": "missing_required_scope", "slots": runbook["missing_slots"]})
    ready = bool(populations) and not unresolved and runbook is not None and not runbook.get("missing_slots")
    return {
        "query": query,
        "detected_intents": intents,
        "matched_workflow": workflow["id"] if workflow else None,
        "populations": populations,
        "recommended_runbook": runbook,
        "runbook_error": runbook_error,
        "unresolved_items": unresolved,
        "ready_to_execute": ready,
        "next_step": "Publish the resolved source plan and obtain approval before source execution." if ready else "Resolve every unresolved item before execution.",
    }


def main():
    if len(sys.argv) != 2 or not sys.argv[1].strip():
        print(json.dumps({"error": "Usage: atomic_fetch.py '<complete finance request>'"}))
        return 1
    print(json.dumps(route(sys.argv[1].strip()), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
