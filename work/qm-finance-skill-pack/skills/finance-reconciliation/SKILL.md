---
name: finance-reconciliation
description: "Reconcile GL controls, subledgers, bank records, or operational extracts at a stated cutoff using identical measurement bases, Decimal arithmetic, complete populations, named reconciling items, and independent evidence-bound review. Use for account tie-outs and break tracing; never post adjustments or widen tolerances to force agreement."
requiredCapabilities: []
---

# Finance Reconciliation

Reconcile only from current-run evidence accepted through QM's evidence and review flow. Bind every source, calculation, exception, review, and result to immutable evidence identifiers and digests. This skill diagnoses and reports; it never changes source records, creates entries, grants its own exceptions, or certifies an audit opinion.

## Establish the comparison

Before matching or calculating:

1. State the entity, accounts, currencies, cutoff, date basis, sign convention, grain, and source authority for each side.
2. Confirm both sides measure the same thing: gross or net, historical as-of or live, transaction or base currency, booked or closing rate, and document or posting date.
3. Validate required fields, unique identifiers, duplicates, missing identifiers, opening balances, and source completeness.
4. Decompose each control into its constituent transaction types or components and prove those parts sum to the control.
5. Where a supplied benchmark has multiple sheets or extracts, test identifier containment before summing; a breakout may be a subset rather than an additional population.

A control is a tie-out target, not automatically an accuracy benchmark. A finance-owned workpaper may be the comparison benchmark while the GL contains named non-document components. Keep the raw GL tie-out visible and explain every difference between the benchmark and the control.

## Reconstruct historical populations

Do not label a live balance as historical. Reconstruct an as-of balance from dated movements:

Define source-specific signed algebra before reconstruction. The equation must identify debit/credit orientation and the treatment of applications, payments, credits, write-offs, reversals, cancellations, and reclassifications; do not assume every source follows `gross - applications`. Use the applying document's effective date for settlement relief. Retain documents open at the cutoff even if they closed later. Keep document balances at their booked currency basis unless an approved method explicitly requires another basis; separate period-end revaluation as a named control component.

For migrated or legacy populations, read [references/migrated-populations.md](references/migrated-populations.md). Treat every documented discriminator as a hypothesis until current evidence confirms it.

## Match and classify

1. Choose the lowest common key and document all secondary rules before use.
2. Use Decimal arithmetic and a threshold approved before observing the result.
3. Produce exhaustive, mutually exclusive populations: matched, amount break, timing break, left-only, and right-only.
4. Prove every source row appears exactly once and both source totals equal the matched population plus all breaks.
5. For rebuilt populations, measure identifier membership and per-document amount agreement. Complete membership with wrong amounts is not a pass.

Use `scripts/reconcile.py` only for exact-key two-sided CSV matching. It does not reconstruct as-of balances, validate source completeness, classify timing breaks, or authorize publication.

## Design the control

Write the algebra explicitly before running it:

```text
control_difference = published_population
                   + named_control_components
                   - approved_named_items
                   - control_balance
```

Cancel any term appearing on both sides on paper. A cancelling term is invisible to the test even when the formula returns a non-zero number. The gate must test the figure actually published, not a related diagnostic.

Set the threshold from approved policy or materiality before seeing the residual. Never calibrate it by rerunning until the result passes.

## Investigate residuals

Trace residuals against current evidence and the decomposed control. Keep causes as hypotheses until supported. Re-run the complete comparison after every correction because multiple defects can coexist.

Legitimate non-document components such as FX revaluation, unapplied cash, credits, provisions, or eliminations belong in named schedules. Derive them from current evidence and display both the unadjusted and adjusted residual.

An unresolved item may be declared only through an explicit finance ruling. Record:

```text
name, amount, cutoff, owner, ruled_by, ruled_on, rationale, evidence_ids
```

Each declared item must be cutoff-scoped, separately disclosed, removable without changing other logic, and retired when resolved. The agent must not create, widen, reuse, or retire an item on its own initiative. A traced mechanism is not closed until corrected at source or explicitly ruled.

If one independent leg is unprovable, block that leg and report the supported legs with the exclusion clearly named. One attestation or control must never suppress another control.

## Evidence and publication boundaries

Do not embed monetary baselines or row counts in the skill, references, or memory. Derive every amount from accepted current-run evidence.

A control passes only when its evidence proves the claimed fields and population. File existence, parseability, a digest-shaped string, or a non-empty row is not attestation.

Every blocked result must identify the failed control, evidence-bound reason, owner, and specific next action. Every successful result must retain the same control evidence, including residuals before and after approved named items. These records are evidence for QM's review flow; they do not replace it.

Before publication:

1. Read [references/review.md](references/review.md).
2. Require a reviewer distinct from the preparer.
3. Give the reviewer the exact source evidence, calculation result, control algebra, named items, and proposed publication artifact.
4. Recompute independently rather than approving the preparer's summary.
5. Open and inspect the published artifact. Verify headline figures, labels, basis statements, attestations, exclusions, and the actual gating control—not only an exit status.
6. Include basis and disclosures generated from the same current-run values: population definitions, cutoff method, currency basis, completeness, exclusions, control test, and every named item's authority.

When a method change flips a result from blocked to publishable, show the old and new calculations at the same cutoff and obtain explicit finance approval before adopting it.
