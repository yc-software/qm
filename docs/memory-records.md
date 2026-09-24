# Structured memory records: storage foundation

This change adds provenance and sensitivity metadata to the Postgres notebook store.
It does **not** yet enforce record-level disclosure restrictions. Existing `read`,
`query`, and `recall` paths continue returning the notebook text. Do not enable or
advertise sensitivity-aware sharing until retrieval integration is complete.

## Stored representation

Each revision retains its Markdown `body` and gains a nullable, versioned `records`
JSONB snapshot. The existing transaction lock and revision check protect both values.
The original migration remains unchanged; a separate additive migration introduces
the column. No production backfill is needed.

Each record has a stable ID, text, sensitivity, source scope/session references, and
an incomplete-provenance flag (`sourceUnknown`). Text blocks include headings and
freeform prose as well as bullets, so arbitrary notebook content is not silently
excluded from the future filtering boundary. The original Markdown remains the
compatibility representation and is not reconstructed from these blocks.

Sensitivity values are `ordinary`, `unknown`, `sensitive`, and `restricted`.
New captures default to `unknown`. Classification is not implemented in this slice.
Trusted capture callers can supply a sensitivity and inherited records; these are
not exposed as agent-controlled API arguments. Missing dependency information sets
`sourceUnknown`, even if the origin scope is known. Source labels inside prose are
never interpreted as authoritative provenance.

Legacy revisions remain readable and receive stable, unknown records on inspection.
Their original sources are not guessed from the notebook they happen to inhabit.
The next mutation persists both old and new records. A rolling deployment's older
writer may still create a NULL-record revision; it is treated as legacy, never as
safe-to-share. File-backed and opaque external providers remain legacy in this slice.

## Mutation rules

- Captures derive the source scope/session from runtime context. Copying a channel
  capture to personal memory keeps its original source rather than claiming the
  personal notebook as its origin.
- Duplicate capture can tighten metadata without duplicating text. The returned
  `added` count still counts text additions, not metadata-only revisions.
- Unchanged text keeps its ID. A changed whole-notebook Markdown rewrite applies the
  previous notebook's combined restrictions to every surviving block. This is
  deliberately conservative: text matching cannot establish which old facts a
  summary or deletion depended on. Exact no-op rewrites do not create revisions.
- Restoration inherits restrictions from all intervening revisions, not just the
  current head. Restoring an empty notebook therefore cannot reset the restriction
  floor before a later restoration. This is a potentially expensive operation for
  long histories, not part of ordinary recall.
- Clearing the notebook still clears its current content. Historical revisions stay
  subject to the existing retention behavior.

## Remaining integration before release

1. Thread trusted dependency records through capture and consolidation, including
   scratch promotion and non-Postgres providers. Add classification with conservative
   defaults; model suggestions must not confer access or clear restrictions.
2. Route every agent-facing read, search, history, and prompt recall through a shared
   access check using the requester, destination audience, and current source access.
   Notebook scope permission alone is insufficient. Ordinary does not mean public.
3. Make opaque providers and unknown legacy records fail closed for widened sharing.
4. Prevent recall-delta from quoting newly ineligible facts and address retained
   prompts, summaries, and harness history when source access changes.
5. Verify the full shared-conversation flow against a live development instance with
   synthetic data, including revoked access, copy/rewrite/restore, and provider paths.

This foundation is not a defense against delete-and-recapture through untracked
external context, nor against agent access through the remaining raw-read paths.
