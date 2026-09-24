# Structured memory records: storage foundation

This change adds provenance and sensitivity metadata to the Postgres notebook store
and applies a shared disclosure view to fresh model recall and agent memory APIs.
It is **not release-ready**: automatic classification and retained model-context
invalidation remain incomplete. Existing memories are not automatically declassified.

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

## Fresh-read disclosure boundary

`disclosedMemory` filters the stored records before rendering or searching them.
It is used for turn-context recall/search, primitive memory tools, the memory-file
redirect, self-API reads/history/restore responses, and shared-turn admin memory
reads. The file redirect never falls back to an unfiltered workspace copy.

The requester must retain access to every recorded source. Cross-context disclosure
requires current Open policies at both ends and a complete current destination roster.
An unknown roster, external room, unresolved member, missing source access, or failed
lookup denies disclosure. Membership and policy decisions are shared within a read,
not cached across reads. An ordinary personal fact can follow its owner into an
eligible Open room; sensitive or restricted facts require the whole destination
audience to be entitled to the original sources. Unknown or incomplete records stay
within the notebook's existing narrow audience. Native org memory keeps its existing
org audience. Ordinary does not mean public.

Provider routes apply disclosure independently to every provider. Structured search
uses filtered records rather than an unfiltered provider query. Opaque providers
retain their original narrow audience and cannot supply carried memories. Direct MCP
tools are separate authorization paths, not covered by this memory-service wrapper.

A partially visible notebook cannot be rewritten. Structured replacement requires
revision-based compare-and-set. Historical reads conservatively inherit restrictions
from newer revisions in the requested newest-first window; restoration also applies
the storage layer's complete intervening-revision floor. Unclassified legacy provider
mutations without CAS retain their old behavior and lack that concurrency guarantee.

Explicit, authorized administrator inspection from a private conversation or the
admin portal remains a raw maintenance operation. Shared-turn admin memory reads use
the ordinary disclosure boundary. Other administrator diagnostics are not claimed to
be memory-filtered.

Recall-delta messages never quote withdrawn text. This prevents a new leak in a
delta, but does not erase information already present in a harness session.

## Remaining integration before release

1. Thread trusted dependency records through capture and consolidation, including
   scratch promotion and non-Postgres providers. Add classification with conservative
   defaults; model suggestions must not confer access or clear restrictions.
2. Invalidate or rebuild retained prompts, summaries and harness history when memory
   eligibility shrinks. The fresh-read filter alone does not provide this guarantee.
3. Run real-model shared-conversation qualification, including copied facts, changed
   audiences, revoked access and provider paths. Current live checks use synthetic
   data through HTTP/Postgres and the development portal with the mock model.

This change is not a defense against delete-and-recapture through untracked external
context. Do not represent it as the completed memory system.
