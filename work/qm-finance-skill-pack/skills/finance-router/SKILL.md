---
name: finance-router
description: "Route ShareChat accounts-receivable, receipt-window, collection, aging, customer-outstanding, and migrated-balance requests into a complete QM source plan with authoritative populations, evidence controls, and independent reviews. Use before AR execution; it does not fetch data or perform analysis."
requiredCapabilities: []
---

# Finance Router

Complete `KNOWLEDGE_READY` before any source read or calculation. Do not inspect unrelated skills, scripts, tests, or prior outputs.

1. Call `finance_skill_run` once with `name: "finance-router"`, `path: "scripts/atomic_fetch.py"`, and `args: ["<complete user request>"]`. Parse stdout as JSON. A nonzero exit or invalid JSON is a routing failure, not a source-system outage.
2. Treat the result as routing evidence, never as source data or a finance conclusion. Preserve the requested deliverable, period, legal entity, subsidiary scope, currency basis, accounting book, comparison basis, reporting timezone, historical cutoff basis, every required population, authoritative source, completeness test, producer skills, reviewer skills, and unresolved items. Never invent an unspecified dimension.
3. Route the supported AR and order-to-cash intents: customer invoices, receipts, open receivables, unapplied cash, customer advances, deductions, migrated balances, aging, and debtor reconciliation. For AP, statements, close, treasury, tax, payroll, valuation, or other unsupported intents, return a precise unresolved routing result rather than inventing a producer or source plan.
4. Keep production and review roles separate. The source plan must identify who produces each population, who reviews raw evidence, who reviews calculations, and who reviews the report. A review of raw rows does not certify later calculations.
5. Request the smallest artifact that answers the question. Define each population with included and excluded transaction types, dates and date basis, posting status, entity and subsidiary, account or segment scope, approval/status filters, currency/book basis, row-count expectation, control totals, as-of timestamp, and data-quality limitations.
6. Preserve domain distinctions rather than borrowing rules blindly. AP and AR may share concepts such as open balance or withholding, but signs, statuses, transaction types, accounts, and date fields can differ. GL balances and subledger populations require an explicit tie-out instead of substitution.
7. Name unavailable evidence precisely. Do not substitute presentation layers, prior workbooks, memory, synthetic rows, or portal assumptions for an authoritative source. A portal-gated or externally supplied population remains unresolved until current evidence is attached.
8. Stop when `ready_to_execute` is not `true`, any population is blocked, or `unresolved_items` is non-empty. Return the exact missing slot, source, population, or control without advancing.
9. Create a routing-evidence JSON object with `request_artifact_id` set to the accepted `REQUEST_BOUND` artifact ID and `routing` set to the complete Atomic Fetch result. Publish it with `finance_artifact_publish` as a descriptive `.json` artifact. Do not use local files or upload scripts.
10. Advance `KNOWLEDGE_READY` once with the accepted request artifact as input evidence and the routing artifact as output evidence. Continue only with the stage skills QM exposes. Stop on publication or transition failure.

Never treat a catalog match as proof that its references were loaded. The workflow receipt must identify the exact `finance-router` body and asset digests used.
