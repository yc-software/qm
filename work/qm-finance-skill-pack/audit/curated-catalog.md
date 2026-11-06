# Curated migration catalog

The source contains 1,476 skill files but only 261 unique names across 11 profile trees. The migration will not preserve profile copies. It will produce one reviewed target per distinct task.

## Pack A: finance operations

### Initial migration wave

| Target                      | Authoritative baseline       | Merge inputs                                                                  | Decision                                                                  |
| --------------------------- | ---------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `finance-router`            | Existing QM `finance-router` | `sharechat-finance-routing`, `finny-domain-links`, `netsuite-data-delegation` | Improve the existing QM-native router; do not import Hermes orchestration |
| `netsuite-readonly-finance` | Existing QM skill            | Executor `netsuite-suiteql`; selected Finny resolver/schema references        | Keep QM broker boundary; curate domain references only                    |
| `sharechat-ar-collection`   | Existing QM skill            | Finny AR collection, executor boundary, AR reporting, tracker, build pitfalls | Preserve current QM-native body and add reviewed missing knowledge/assets |
| `sharechat-ap-operations`   | Finny `sharechat-ap-ops`     | executor `ap-l2-queue`, `ap-approval-digest`, AP workbook rules               | New consolidated AP operations skill; remove Hermes/Kanban/Slack coupling |
| `sharechat-pl-mis`          | MIS Expert variant           | executor query-boundary differences, monthly MIS controls                     | New QM-native MIS skill after direct-client removal                       |
| `month-end-close`           | Existing QM skill            | MIS `month-end-close-preflight`, rebuild-trigger controls                     | Strengthen existing close skill; keep workflow implementation in QM       |
| `sharechat-ebitda-bridge`   | MIS Expert variant           | executor investor bridge and ShareChat format                                 | One consolidated EBITDA skill                                             |
| `finance-reconciliation`    | Existing QM skill            | CFO-HR `subledger-gl-reconciliation`, control tie-out verification            | Strengthen existing reconciliation skill                                  |

### Later operations wave

- `sharechat-topsheet`
- `sharechat-daily-ns-ops`
- `morning-mis-check`
- `sharechat-income-statement`
- `sharechat-segment-report`
- `sharechat-wallet-reconciliation`

## Pack B: finance audit and tax

| Target                         | Baseline             | Merge inputs                                        |
| ------------------------------ | -------------------- | --------------------------------------------------- |
| `financial-report-quality`     | `report-qc`          | `output-makes-sense`, `self-explaining-output`      |
| `financial-forensic-review`    | `forensic-red-flags` | Relevant existing QM statement-audit controls       |
| `sharechat-ap-msme-compliance` | Finny body           | Executor-safe query references; tax controls        |
| `sharechat-gst-audit`          | Tax Expert variant   | `sharechat-netsuite-gst`, GST compliance references |
| `tax-audit-packet`             | Tax Expert variant   | Reviewed reference assets                           |

## Pack C: accounting standards

Create a separate reference pack from the Auditor copies of the Ind AS library. Include the reference index, concordance, Schedule III material, and judgement guidance. Do not autoload the complete library into every finance turn.

## Pack D: finance modeling

Optional later pack:

- `excel-author`
- `three-statement-model`
- `dcf-model`
- `comps-analysis`
- `lbo-model`
- `merger-model`

Prefer QM's existing office/spreadsheet runtime rather than preserving Hermes-specific openpyxl or LibreOffice paths. Exclude `fpa-modeling-openfpa` unless the dependency is deliberately provided and tested.

## Exclusions

Do not migrate:

- Hermes agent operation, configuration, desktop, gateway, profile, or skill-authoring skills
- Finny brain, self-audit, board, queue, run-receipt, and path-correction implementation
- Hindsight runtime/configuration skills
- Kanban and Hermes delegation orchestration
- Resolver synchronization jobs and mutable caches
- Generated reports, logs, backups, local databases, binary caches, or production snapshots
- Generic non-finance media, gaming, creative, MLOps, and productivity trees

## First implementation slice

Start with four targets that already have a strong QM-native foundation or a bounded consolidation path:

1. `sharechat-ar-collection`
2. `netsuite-readonly-finance`
3. `finance-router`
4. `finance-reconciliation`

This slice validates the pack format, reference preservation, QM broker boundary, discovery descriptions, scripts, and staging process before taking on AP and MIS bundles with broader runtime dependencies.
