# Finny evaluator authority and same-artifact re-verification

## Goal

Preserve FinnyLoop's r5 trust boundary when deterministic evaluator semantics change. Core must re-open only evaluator-owned verification requirements for the same immutable artifact, retain every historical BLOCK and attestation, never wake Producer for an evaluator-only correction, and finalize only against the exact current evaluator authority.

## Boundary

- Core owns approved evaluator references, requirement generations, typed reason catalogues, append-only correction events, dispatch routing and finalization.
- The deterministic worker receives immutable bytes plus a Core binding and returns typed PASS, BLOCK or ERROR outcomes and canonical evidence.
- Skills own finance procedure and remediation language.
- Producer changes artifacts only for proven artifact defects.
- Auditor independently submits accepted evidence; it cannot choose evaluator identity or required checks.

## Evaluator authority

Each approved evaluator is identified by an exact tuple:

- `id`
- `revision`
- `buildDigest`
- `contractVersion`
- `configurationDigest`

The tuple is persisted in the job policy, included in deterministic worker bindings and evidence envelopes, and bound into the final receipt. A nonmatching or stale tuple is rejected even when the artifact, generation and envelope digest are otherwise valid.

## Typed outcomes

- `pass`: evidence satisfies the check; no reason is present.
- `block`: typed evidence proves an artifact defect; a check-specific bounded reason is required.
- `error`: evaluator or infrastructure failure; retry or escalate, but never create a BLOCK attestation or Producer rework.

Human-readable messages are presentation. Core policy uses only validated typed outcome/reason fields.

## Append-only correction transition

For evaluator `E1` to `E2` over unchanged artifact `A`, Core atomically appends:

1. `evaluator_revision_activated`
2. `evidence_invalidated`
3. `rework_cancelled` when the pending rework came from a deterministic BLOCK
4. `verification_reopened`

The transaction:

- locks the job;
- validates the current evaluator and source BLOCK;
- preserves artifact digest and provisional revision;
- advances only Core-owned deterministic check generations;
- clears only the matching pending rework;
- keeps all prior events and attestations unchanged;
- is idempotent;
- rejects finalized, escalated, unrelated or non-deterministic jobs.

A `verification_reopened` recovery opens a fresh Auditor generation and dispatches no Producer work.

## Current shadow-run migration

The October 2026 revision 2 workbook remains immutable. Its historical BLOCK and delivered Producer rework are retained. Because the old pre-authority policy already over-invalidated several checks, the shadow run may need to recompute those current generations once; no history is deleted or generations decremented. The correction event records the prior evaluator as legacy-unpinned and the newly approved evaluator tuple explicitly.

## Gates

1. Hardcoded spreadsheet remediation is absent from Core prompts and integration logic.
2. Stale/missing evaluator authority is rejected.
3. Typed reasons reject unknown or cross-check reason codes.
4. ERROR never produces BLOCK or Producer rework.
5. Same artifact digest/revision survive correction.
6. Only deterministic requirement generations advance in a clean correction case.
7. Historical BLOCK remains queryable after current PASS.
8. No Producer dispatch is created by correction/re-verification.
9. Restart recovery converges to one current Auditor grant.
10. Final receipt binds the exact evaluator authority.
11. Focused and broader regression suites pass.
12. Independent architecture and adversarial reviews are resolved before live replay.
