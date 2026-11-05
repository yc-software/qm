# Finance reconciliation source selection

## Target

`skills/finance-reconciliation/` remains a single QM-native reconciliation skill. It consolidates reusable control logic without importing a second overlapping `subledger-gl-reconciliation` or `control-tie-out-verification` skill.

## Baseline retained

The QM baseline is authoritative for runtime and governance boundaries:

- current-run immutable evidence identifiers;
- explicit keys, tolerances, date basis, signs, and currencies;
- Decimal arithmetic;
- exhaustive matched and unmatched populations;
- no plugs or suppressed differences;
- independent reviewer distinct from preparer;
- review bound to exact evidence and result digests;
- diagnostic-only behavior with no entries, source mutation, or audit opinion;
- the bounded exact-key CSV helper.

## Source selected: `subledger-gl-reconciliation`

Selected reusable accounting rules:

- decompose a GL control before constructing the subledger;
- force both sides onto the same gross/net, live/as-of, and currency basis;
- reconstruct historical open balances from dated movements rather than live open fields;
- use applying-document dates for settlement relief;
- keep booked-rate subledger balances separate from period-end revaluation;
- simplify control algebra to identify cancellation;
- gate the figure actually published;
- set tolerances before observing the residual;
- use cutoff-scoped, finance-owned, named reconciling items instead of widening tolerance;
- validate settlement through counterparty accounting rather than link labels alone;
- test migrated populations per wave and discriminator;
- compare expected and derived membership both ways;
- avoid stored monetary baselines;
- scope fail-closed behavior to the unsupported leg;
- inspect the published artifact and carry basis/disclosures on its face.

The original SQL example and product-specific query mechanics were excluded. QM must obtain source evidence through its approved broker/tool and evidence flow rather than teaching direct database access in this skill.

## Source selected: `control-tie-out-verification`

Selected reusable control and review rules:

- distinguish a tie-out target from an accuracy benchmark;
- check workbook sheet containment before aggregation;
- measure rebuilt populations on membership and amount;
- retain raw and adjusted residuals;
- require explicit finance approval when a method change flips block/publish behavior;
- prevent one control or attestation from suppressing another;
- require evidence to prove claimed fields and populations, not merely file existence, parseability, or shape;
- pair blocked controls with attributable reasons, owners, and next actions;
- preserve equivalent control evidence on successful publication;
- verify labels, attestations, headline figures, and the actual gating control in the rendered artifact.

The source's Finny-specific structured record names, runbook terminology, dashboard/scoring system, shell-based harness instructions, and multi-workstream plan mechanics were excluded. QM owns workflow evidence, review, durability, and publication state.

## References

Added `references/migrated-populations.md` as a concise neutral extraction of reusable migration-wave, settlement, currency, and membership rules.

Expanded `references/review.md` to cover population basis, algebra, named items, evidence quality, independent recomputation, and publication inspection.

The large `measurement-layer-pitfalls.md` source was not copied. Most of it concerns scoring, callbacks, compatibility aliases, emission paths, and implementation governance outside this skill's responsibility. The relevant reconciliation controls were integrated directly into the skill and review checklist.

## Explicit exclusions

- Hermes, Finny, profile, home-directory, CLI, terminal, and tool assumptions
- Hindsight or memory-runtime dependencies
- direct NetSuite client/API/SQL instructions
- hardcoded account identifiers, endpoints, rates, amounts, row counts, or thresholds
- generated logs, workpapers, output files, caches, and binaries
- instructions to mutate application code or deploy a measurement system
- self-authorized exceptions, adjustments, or publication decisions
- duplicate target skills with overlapping triggers

## Resulting boundary

The migrated skill explains how to construct, investigate, review, and disclose a reconciliation. It does not retrieve data directly, grant access, replace QM evidence acceptance, replace independent review, post adjustments, or decide that an unsupported figure may publish.

No configuration, schema, credential, or live QM skill record was changed.
