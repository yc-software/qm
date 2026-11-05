# ShareChat AR source selection

## Target

`skills/sharechat-ar-collection` remains one QM-native skill for current-run AR extraction, historical cutoff reconstruction, migrated-SAP reconciliation, weekly receipts, workbook production, and management follow-up analysis.

The existing QM-native bundle is the execution authority. It already routes source reads through `netsuite_execute`, binds calculations to immutable evidence, invokes the report generator through `finance_skill_run`, and requires independent raw, derived, and presentation reviews.

## Sources reviewed

- Existing QM-native `sharechat-ar-collection` bundle
- Finny `finny-brain-ops/sharechat-ar-collection`
- NetSuite Executor `finny-brain-ops/sharechat-ar-collection`
- Finny `finny-brain-ops/ar-collection-reporting`
- Finny `sharechat-ar-collection-tracker`
- Finny `finny-brain-ops/sharechat-ar-build-pitfalls`

The Finny AR skill was the richer domain source. The executor variant was useful for validating the read-only source boundary. Neither replaced the QM-native execution model.

## Selected and merged

### Accounting population

Retained the QM-native rules for:

- posted trade-debtor lines on GL 111001 and 112001;
- native `CustInvc` and both migrated-SAP legs;
- cutoff-date replay of payments, credits, reversals, and write-offs;
- canonical SAP reference and document-date fields;
- booked-rate conversion and explicit native/SAP deduplication;
- current-run GL controls and zero-difference reconciliation.

### Weekly reporting and management analysis

Merged reusable concepts from `ar-collection-reporting`:

- over-15-DPD as an operational follow-up threshold without replacing the accounting buckets;
- customer segment, business vertical, government status, and collection-owner views when mappings are authoritative;
- clearing rate defined against opening overdue exposure for the same population;
- distinct administrative treatment for government balances;
- policy-owner approval for credit hold, legal recovery, provision, and write-off actions;
- like-for-like controls for week-over-week comparisons.

### Manual annotation preservation

Merged only the durable principles from the tracker:

- manual annotations need a stable key, author, and update timestamp;
- refreshed source data cannot erase a verified non-empty annotation with a blank;
- customer defaults may fill missing invoice owners only when labelled as inherited;
- annotations never alter source-backed accounting values.

The SQLite carry-forward implementation and remembered baseline populations were not selected.

### Diagnostic knowledge

Merged reusable pitfalls:

- a weekly request must not silently become a single-day receipt window;
- zero rows in an active period do not prove an empty population;
- stale or cached workbooks must be distinguished by artifact ID and audited digest;
- current reconciliation gaps cannot be repaired with old or hard-coded reconciling amounts;
- residuals must distinguish settled items, credit offsets, unapplied cash, source-sync lag, unprovable SAP legacy items, and unknown differences.

## Asset decisions

Retained the SAP classification reference only. The bundled generator, refresh module, and their tests were removed after independent review found account-specific query compilation, fixed scope, unverified side inputs, and legacy delivery behavior. Calculation and workbook generation now remain deployment-side QM responsibilities bound to accepted source-plan and evidence artifacts.

No Hermes-generated backups, bytecode, local databases, cached workbooks, logs, or binary artifacts were copied.

The later Finny audit-manifest schema and helper were not merged in this pass because they are coupled to a newer generator branch and would duplicate QM's durable evidence and workflow receipts without a demonstrated gap.

## Excluded

- All Hermes and profile paths, metadata, tool syntax, delegation, cron, and gate workarounds
- Hindsight recall or retention calls and remembered figures
- Direct `netsuite_kb.client`, REST, TBA, environment-file, or local credential access
- Model-authored or ad-hoc SQL execution outside the approved QM compiler and broker boundary
- Persistent SQLite carry-forward stores and fixed row/rupee baselines
- Named reconciling amounts, remembered residuals, and person-specific approvals
- Stale period-ID tables, historical production examples, and hard-coded current facts
- Slack delivery phrasing workarounds and obsolete workflow-state escape instructions
- Source-system mutation, credit hold, legal action, provision, or write-off without human policy approval
- Raw SQL snippets whose useful rule is already represented by the governed query compiler contract

## Resulting boundary

The migrated skill contains reusable accounting, analysis, annotation, and diagnostic knowledge. QM remains the owner of credentials, source-plan approval, query compilation, brokered retrieval, immutable evidence, reviewer gates, script execution, and durable artifacts.
