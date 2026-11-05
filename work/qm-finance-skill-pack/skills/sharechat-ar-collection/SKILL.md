---
name: sharechat-ar-collection
description: "Build and diagnose evidence-controlled ShareChat accounts-receivable reports, weekly collections, receipt windows, debtor aging, overdue follow-up, and native NetSuite versus migrated SAP reconciliation."
requiredCapabilities: []
---

# ShareChat AR Collection Skill

Build receipt-window and outstanding-receivables reports from current-run evidence.
This skill owns the accounting population and reconciliation rules. A separate MIS
or spreadsheet skill may improve presentation, but it must not redefine the population.

## When to Use

Use this skill for:

- receipts for an explicit date window;
- open receivables as of an explicit cutoff;
- AR aging, customer or vertical summaries;
- native NetSuite and migrated SAP trade-debtor reconciliation;
- weekly collection workbooks and their independent audit handoff;
- investigation of empty receipt windows, subledger-to-GL gaps, SAP orphan populations, unapplied cash, credit offsets, and stale report artifacts;
- leadership views of overdue exposure by customer segment, business vertical, government status, and collection owner when those dimensions have authoritative mappings.

Do not use it for AP, unbilled revenue, or GL-only balances without invoice-level
support. Route those intents to the applicable finance skill selected by the skill
resolver.

## Source-of-Truth Hierarchy

The report population is defined only by current-run evidence. Never make a row count,
invoice count, or monetary amount pass by comparing it with a fixed expected baseline.
Historical examples, earlier reports, chat messages, memories, and prior workbooks are
context—not accounting evidence for the current run.

Authority is population-specific rather than a universal ranking:

1. Use the current query-bound NetSuite extract for populations represented in NetSuite, with source timestamp, query digest, result digest, and row-count attestation.
2. Use a current QM-accepted and digest-bound SAP artifact for migrated populations not fully represented in NetSuite. Its schema, signature or approval receipt, entity, and cutoff must be verified before use.
3. Use a current finance-approved GL or trial-balance artifact as the control for the requested entity, accounts, currency, book, and cutoff. A control does not replace subledger detail, and subledger detail does not replace the control.
4. Use prior files only for non-financial manual annotations such as owner, follow-up status, and remarks. Never carry forward amounts, dates, clearing status, or population membership from them.

If a required current-run source or signature is absent, publish no combined total and
no workbook. State the missing control precisely. Do not substitute a cached export,
mutable tracker, remembered number, or manually pasted add-back.

## Prerequisites

Before writing a query or reporting a number:

1. Use the accepted QM request, routing, and source-plan evidence. Do not rerun routing
   or replace an approved population or scope.
2. Let QM compile the registered, pinned generator from the durable human-approved
   source plan. Do not run a query compiler yourself or supply SQL, rows, or query bundles.
3. **Execute only through the approved read-only source boundary.**
   - If `missing_slots` is non-empty, ask for exactly those slots and stop.
   - After `PLAN_APPROVED`, call `netsuite_execute` with `{}`. QM owns query compilation,
     pagination, and immutable source-evidence storage; the result contains population
     counts and the raw-evidence artifact ID and digest, not rows for model arithmetic.
   - Never give a local script NetSuite credentials or let it perform direct source reads.
   - Advance `RAW_EVIDENCE_READY` with the accepted plan as `inputEvidence` and both
     returned evidence references—`rawEvidenceArtifactId`/`rawEvidenceSha256` and
     `queryBundleEvidence.id`/`queryBundleEvidence.digest`—as `outputEvidence`. This lets
     the independent reviewer inspect the exact governed query definitions and results.
     Do not copy or republish source
     rows as a model-authored artifact. If execution fails, report the exact tool error
     and failing stage; do not describe a missing tool or approval as a NetSuite outage.
4. After the raw-evidence reviewer passes, derive calculations only through the QM-owned, pinned AR calculation and workbook tool exposed for the approved workflow stage. Pass the accepted source-plan artifact, raw-evidence artifact IDs and digests, and approved receipt start, receipt end, and cutoff. The tool—not this skill—owns query binding, Decimal calculations, workbook generation, atomic output, and artifact publication. Use its returned durable dataset and workbook artifact IDs and digests as report evidence; do not execute a bundled source compiler or rebuild rows from conversation text.
5. Stop after the governed calculation and review stages complete. If a stage returns a block, report its missing control, verified populations, and unblock instruction without estimating, substituting a prior workbook, or repeatedly rerunning the same evidence.
6. Record the requested entity, receipt start, receipt end, outstanding cutoff,
   timezone, currency, and controlling GL accounts. Ask only for values that cannot be
   resolved from the request, resolver, or authoritative memory.

## Population Contract

### Trade-debtor scope

- Invoice-backed trade AR is restricted to posted accounting lines on the receivable accounts in the accepted, versioned source-plan/config artifact for the requested entity, book, and cutoff.
- Treat every excluded account, invoice family, entity, and transaction type as governed configuration. Record each exclusion and reason in the row manifest. Block when the applicable configuration artifact is missing, stale, or does not cover the requested scope.
- A current source row, not an invoice-number prefix or date heuristic, determines
  whether the row is native NetSuite or migrated SAP.
- Deduplicate by normalized finance reference plus source transaction identity. Never
  add the SAP classification list to the invoice population when those invoices already
  exist in the open-invoice detail.

### Native NetSuite invoices

- Start from `CustInvc` transactions with posted accounting lines on the scoped GLs.
- Include only invoices whose document date is on or before the requested cutoff.
- For a current-date cutoff, use the live open balance only when its transaction and
  application population is complete and attested.
- For a historical as-of cutoff, reconstruct the invoice balance from dated source
  movements. Include invoices later closed if they were open at the cutoff. Exclude
  invoices created after the cutoff.
- Payment, credit, reversal, and write-off movements affect the balance only when their
  effective transaction date is on or before the cutoff. Do not infer historical
  outstanding from today's status alone.

### Migrated SAP invoices

The approved source-plan/config artifact defines every migrated-population leg, discriminator, cutover boundary, and canonical field for the requested entity and cutoff. Treat date boundaries, record types, and field IDs as versioned configuration rather than timeless rules. Block when current evidence cannot validate that configuration against the source metadata and population.

Use the posted transaction-accounting line as the INR monetary evidence. Clearing flags
are diagnostic only because the migrated population does not populate them reliably.
Determine outstanding at the cutoff from dated, validated settlement transactions.
A source application link is a candidate relationship, not proof by itself: validate settlement type, effective date, entity, invoice identity, currency, sign, and amount before relief. Prefer source-provided base-accounting amounts. Reconstruct a base amount from a booked rate only when the approved accounting policy and source evidence establish that rate for the movement; isolate FX differences rather than folding them into settlement. Never subtract a foreign amount directly from a base-currency accounting line or treat an FX reclassification as invoice settlement.

For the Journal leg, the canonical SAP reference and document date remain mandatory for
published rows. For the unmarked `CustInvc` leg, preserve its invoice number and document
date with an explicit cutover-classification disclosure. When current source data cannot
prove settlement state or booked-rate conversion, block the combined report and record
the field gap.

## Exact Date and Sign Rules

### Inclusive receipt window

The inclusive receipt window is:

```text
receipt_start_date <= source transaction date <= receipt_end_date
```

- Apply the bounds in the source query and validate every returned row again before
  publication.
- A row outside either boundary is excluded and logged; an upstream result that ignores
  the predicates fails the run.
- NetSuite-posted receipts are `CustPymt` transactions. Link allocations to invoices
  through `NextTransactionLineLink` with `linktype = 'Payment'`; never attach the same
  UTR to all invoices of a customer.
- Report cash receipts as positive values. Preserve the signed debtor-ledger amount in a
  separate source-sign field when useful for audit.
- If a current authoritative bank or treasury source is available, include unposted
  direct-bank and international receipts only as separately labelled populations. They
  must have immutable source identities and dates inside the same window. Never relabel
  them as NetSuite-posted receipts.
- Deduplicate payment accounting lines by source transaction ID and distinguish gross
  bank cash, allocated invoice amount, and unallocated amount.

### Outstanding cutoff

The historical as-of stock is the balance at the close of the requested cutoff date in
the stated timezone. It includes eligible invoices issued by then, less only eligible
movements effective by then. Later settlements are excluded from the cutoff balance and
retained in the replay manifest as post-cutoff movements.

Flow and stock must remain separate:

- receipts and newly issued invoices use the requested movement window;
- outstanding receivables use the cumulative cutoff;
- earlier invoices are valid in stock and must not be described as newly issued.

## Query and Retrieval Procedure

1. Reuse the accepted routing and source-plan artifacts; their resolved fields and
   populations are the retrieval contract. Do not rerun preflight after approval.
2. QM executes the pinned compiler and its complete query batch through `netsuite_execute({})`.
3. The compiler covers receipts, native invoices, applications and credits, and both SAP
   populations. No model-authored SQL or alternate source can replace this batch.
4. Verify that every expected population and page is present in the broker-attested
   evidence. Stop on a missing population or incomplete source response.
5. Validate every source envelope, completeness marker, returned date, unique identity,
   and query/result digest before calculations.
6. Normalize dates, currency, reference keys, and signs without overwriting raw source
   values.
7. Build an inclusion/exclusion manifest for every candidate invoice and receipt.
8. Reconcile and audit before formatting the workbook.

## Reconciliation Controls

The run must calculate its expected controls from the signed current-run sources, never
from values written in this skill.

Require all applicable controls to be zero-difference within a control- and currency-specific tolerance approved before the result is known. INR 0.02 is acceptable only when the approved rounding policy explicitly assigns it to that control:

- detailed receipt rows to each source subtotal;
- allocated plus unallocated cash to gross source cash;
- native invoice detail to native AR subtotal;
- SAP invoice detail to SAP AR subtotal;
- native AR plus SAP AR to combined trade AR;
- combined trade AR by GL to the current signed GL or trial-balance control;
- workbook tables to the audited calculation dataset;
- unique published IDs to manifest inclusions, with duplicates disclosed separately.

If a control is non-zero, do not publish. Return the control name, difference, affected
row identities, and source attestations needed to resolve it.

## Workbook Contract

Create a workbook only after the population contract passes. Use typed numeric cells and
typed dates so filters, pivots, and sorting behave correctly.

Required sheets:

1. `Summary` — reporting window, cutoff, source identities, receipt categories, native
   AR, SAP AR, combined AR, and reconciliation status.
2. `Receipts` — one row per source receipt with posted/direct/international category,
   gross cash, allocated amount, unallocated amount, UTR, source ID, and linked invoices.
3. `Open Invoices` — native `CustInvc` rows only, with customer, document/due dates,
   original amount, outstanding at cutoff, DPD, aging bucket, GL, and source identity.
4. `SAP Legacy Invoices` — migrated SAP rows only, with canonical reference, original SAP
   document date, customer, open amount, clearing evidence, DPD, and aging bucket.
5. `Reconciliation` — every control, left value, right value, difference, and source
   digest.
6. `Field Gaps` — missing fields, blocked calculations, and explicitly unavailable manual
   dimensions.

Manual collection annotations may be joined by invoice reference into dedicated columns,
but must be visually distinguished and must not change source-backed accounting values.
Preserve an annotation only when it has a stable invoice or customer key, author, and
update timestamp. A refreshed source row may not erase a non-empty verified annotation
with a blank value. Customer-level defaults may fill a missing invoice-level owner, but
the workbook must label the value as inherited rather than source-reported.

## Management Analysis

Add management cuts only after the accounting population and controls pass:

- Show current, 1–15 DPD, and over-15 DPD exposure; over 15 DPD is the operational
  follow-up threshold, not a change to the accounting aging buckets.
- Break down exposure by customer segment, business vertical, government status, and
  collection owner only when the mappings are current and source-backed. Put unmapped
  amounts in an explicit `Unassigned` bucket rather than dropping them.
- Calculate clearing rate as receipts during the period divided by opening overdue
  exposure for the same population. Do not divide by closing exposure or mix population
  definitions between numerator and denominator.
- Keep government receivables distinct from commercial debtors. Recommend administrative
  escalation for government balances; do not automatically apply commercial credit-hold
  language.
- Treat credit-hold, legal-recovery, provision, or write-off labels as recommendations
  requiring the applicable human policy owner. Age alone is not approval.
- Compare week-over-week movements only when both snapshots use the same cutoff, currency,
  population, and classification rules. Otherwise state that the comparison is unavailable.

## Golden Loop Publication Gates

The gates are sequential and mandatory. The auditor must issue two distinct Gate 1 receipts;
a single combined audit receipt does not satisfy this contract.

### Gate 1A — Raw extraction auditor

Before any derived total or workbook is approved, the finance auditor verifies the raw
source envelopes, query and result digests, source timestamps, completeness markers,
exact receipt predicates, candidate invoice identities, canonical SAP fields, accounting
lines, clearing evidence, and non-overlapping source slices. The Gate 1A receipt is bound
to the immutable raw extraction digest. Any missing or unsupported source population is
`BLOCK`; no derivation may proceed.

### Gate 1B — Derived figures auditor

Run only after Gate 1A returns `PASS`. A reviewer with a distinct identity from the Gate 1A reviewer verifies all
normalization, signs, exclusions, deduplication, historical replay, aging, subtotals,
combined totals, row manifests, and zero-difference controls. It also proves that the
derived dataset and workbook values were produced only from the Gate 1A extraction. The
Gate 1B receipt must reference the Gate 1A receipt and bind the derived dataset and
workbook digest. Any unsupported figure or transformation is `BLOCK`.

### Gate 2 — Report QC

Run only after both Gate 1A and Gate 1B pass. Report QC verifies sheet names, typed
values, filters, labels, visible SAP separation, traceability, readability, and attachment
integrity. Presentation changes must not alter the Gate 1B dataset or workbook digest. A
mutation of raw evidence returns the run to Gate 1A; a mutation of calculations or derived
rows returns it to Gate 1B.

The required order is raw extraction `PASS` → derived figures `PASS` → Gate 2 `PASS`.
Publish only after that sequence completes. Preserve both distinct Gate 1 receipts and the
Gate 2 receipt with the delivered workbook digest.

## Pitfalls

- Do not force the output to a remembered total or invoice count.
- Do not add a support/classification list on top of the same invoice population.
- Do not use current `amountremaining` as a historical balance without dated replay.
- Do not use line SAP reference or posting date when canonical header fields are present.
- Do not treat the absence of a native invoice as proof that a legacy item was settled.
- Do not merge bank credits, posted receipts, and allocations into one unexplained total.
- Do not publish text-formatted money or dates in Excel.
- Do not let a presentation skill override this accounting contract.
- Do not run a single-day window for a weekly receipt request unless the user explicitly
  asks for that day. Resolve the intended reporting cadence before execution.
- Do not repair a subledger-to-GL difference with a remembered or hard-coded reconciling
  amount. Classify the current residual from current evidence and obtain a new finance ruling.
- Do not treat a zero-row active-period result as evidence that the population is empty;
  verify query completeness and the requested dates, then block if completeness is unproven.
- Do not treat an old download, cached workbook, or similarly named attachment as the
  current report. Confirm the artifact ID and audited digest before diagnosing its contents.
- Do not collapse settled invoices, credit offsets, unapplied cash, source-sync lag,
  unprovable SAP legacy items, and unknown differences into one residual. Report each
  supported category separately and escalate unprovable legacy or unknown items.

## Verification

Before handoff, confirm:

- all current-run evidence and signatures are attached to the run trace;
- every receipt date passes the inclusive bounds;
- every invoice balance is evaluated at the exact cutoff;
- every SAP row uses the canonical reference and original document date;
- all row manifests and zero-difference controls pass;
- the workbook digest matches the audited artifact;
- Gate 1A raw extraction passed, then Gate 1B derived figures passed, then Gate 2 passed;
- both distinct Gate 1 receipts and the Gate 2 receipt are retained.

After successful delivery, retain only reusable schema or rule corrections through QM's approved durable-memory path; never retain current report figures as future expected baselines.
