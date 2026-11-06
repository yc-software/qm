# Finance source-plan resolver

Use this reference to classify a request and define complete source populations before execution. It does not authorize a source read and contains no credentials or client instructions.

## Intent classes

### Accounts receivable

Triggers include accounts receivable, AR aging, collections, receipts, overdue invoices, customer outstanding, unapplied cash, customer advance, migrated debtor balance, and debtor reconciliation.

Required population dimensions:

- legal entity and subsidiary scope;
- accounting book and currency basis;
- invoice issue-date and outstanding cutoff basis;
- receipt movement window when requested;
- transaction types, posting status, scoped receivable accounts, and exclusions;
- native and migrated populations kept distinct until reconciled;
- dated applications, credits, write-offs, reversals, and settlements;
- subledger-to-GL control and unique source identities.

Preferred producer skill: `sharechat-ar-collection` for ShareChat collection and aging work, otherwise the approved AR producer exposed by QM.

### Accounts payable

Triggers include accounts payable, AP aging, vendor bills, payment approvals, vendor outstanding, advances, credits, GST holdback, and MSME compliance.

Required population dimensions:

- legal entity, subsidiary, accounting book, and currency;
- bill and payment date basis;
- open-balance cutoff;
- transaction, approval, posting, and vendor-status filters;
- advances, credits, withholding, and holdbacks as separate populations;
- AP subledger-to-GL control;
- payment-release authority treated separately from accounting evidence.

### General ledger and statements

Triggers include GL, trial balance, ledger, journal, P&L, profit and loss, balance sheet, revenue, expense, department, segment, EBITDA, and variance.

Required population dimensions:

- accounting period and whether it is open, soft-closed, or closed;
- legal entity, subsidiary hierarchy, consolidation/elimination basis;
- accounting book, currency, and translation basis;
- posting and account filters;
- comparative period or budget/forecast basis;
- trial-balance control and statement mapping provenance.

A management presentation cannot substitute for the signed ledger or trial balance.

### Close and MIS

Triggers include month end, close readiness, accrual, monthly MIS, topsheet, budget variance, forecast, and management reporting.

Required populations are defined per component. Source reads, calculations, adjustments, presentation, and reviews remain separate stages. Mutable prior workbooks can supply annotations or format expectations only, never current financial amounts.

### Treasury

Triggers include bank balance, liquidity, investment, cash position, payment release, and treasury reconciliation.

Book-side cash and bank-side evidence are distinct. If the authoritative bank or treasury source is unavailable, keep that population unresolved rather than substituting the GL.

### Tax and statutory

Triggers include GST, TDS, RCM, MSME, payroll tax, return reconciliation, and tax audit.

Separate book-side evidence from portal-filed or statutory evidence. The absence of portal evidence blocks portal conclusions but need not block a clearly labelled book-side analysis.

### Reconciliation and audit

Triggers include reconcile, tie out, audit, control, variance, unexplained difference, and forensic review.

Every reconciliation plan names both independently derived sides, cutoff, scope, currency, book, sign convention, bridge keys, permitted finance-owned reconciling items, a tolerance approved before the result is known, and an independent reviewer.

## Source request contract

Each requested artifact must state:

1. The finance question and decision it supports.
2. Complete included and excluded populations.
3. Entity, subsidiary, period or cutoff, timezone, currency, book, account, segment, and status scope.
4. Authoritative source and approved producer skill.
5. Query or extraction lineage and pinned generator identity.
6. Expected completeness markers, page coverage, row count, unique identities, and control totals.
7. Data-quality limitations and unresolved evidence.
8. Raw-evidence reviewer, calculation reviewer, and report reviewer.

Request the smallest authoritative artifact capable of answering the question. Do not request an entire ledger when a bounded subledger population and its control are sufficient.

## Cross-domain safeguards

- Similar names do not imply shared transaction types, signs, statuses, dates, accounts, or joins.
- Withholding, GST holdbacks, RCM, advances, credits, and unapplied cash remain distinct unless the approved domain skill defines a valid bridge.
- A subledger is not a replacement for the GL, and the GL is not a replacement for invoice or bill detail.
- Historical as-of balances require dated replay when the current status cannot prove the cutoff state.
- Prior reports and memory are context only. Current monetary facts require current accepted evidence.
- Source unavailability, access denial, incomplete paging, missing controls, or ambiguous scope are blockers to the affected conclusion.
