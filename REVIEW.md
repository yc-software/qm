# Review Policy

@CODING_STANDARDS.md

This file defines the code review policy, severity expectations, and evidence requirements for this repository.

## Findings and Evidence

- Ground every finding in observable code paths, concrete reproductions, or specific violated standards. Avoid speculative concerns or hypothetical failures that lack observable mechanisms.
- When flagging an issue, cite the concrete defect class and propose the smallest change that simplifies the code and resolves the defect.

## Severity Definitions

- **Blocking (Request Changes)**:
  - Violations of core invariants: in-memory state leakage for durable data, unhandled errors that discard failure evidence, regression in shared module boundaries or core protocols.
  - Presence of comments or type/lint suppression directives in code.
  - Unnecessary complexity or added compatibility shims where a clean migration is required.
  - Arbitrary caps or truncation that hide failures or restrict legitimate payloads.
- **Non-blocking (Suggestions / Comments)**:
  - Opportunities to use existing shared utilities rather than bespoke local logic.
  - Minor naming or structure improvements that preserve existing behavior without altering module boundaries.

## What Not to Flag

- Do not flag formatting, import ordering, or syntax choices enforced by automated CI formatters and linters.
- Do not request explanatory comments, docblocks, or TODO notes in code files; code must remain free of comments.
- Do not suggest backward-compatibility shims or dual-path fallbacks for retired patterns or schema columns; prioritize clean migrations.
- Do not ask for artificial protective limits or throttles unless backed by a measured bottleneck or external API constraint.
