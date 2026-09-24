# Structured memory records: storage foundation

This change adds provenance and sensitivity metadata to the Postgres notebook store
and applies a shared disclosure view to fresh model recall and agent memory APIs.
Automatic capture classification and durable retained-context invalidation are included.
Existing memories are not automatically declassified. See the conservative behavior
and qualification limits below before rolling this out.

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

## Classification and capture dependencies

The existing extraction request classifies each extracted batch using its strongest
sensitivity. Explicit fact capture uses the same conservative labels through the
memory strategy wrapper. Missing labels, malformed output and classifier failure
produce `unknown`. Classifier output never supplies source scopes or removes inherited
restrictions. The classifier is a model estimate, not proof that a fact is harmless.

Turn captures inherit the records actually vended at turn start. When prior history,
tools, attachments or other untracked context may have contributed, known dependencies
are retained and an unknown-provenance marker prevents widening. Bursts retain the
union of their dependencies and do not mix sessions. Existing legacy records remain
unknown. Scratch promotion and opaque providers stay conservative: no cross-origin
personal CC, and scratch captures with known foreign dependencies are refused rather
than silently stripping their source. Full provenance for arbitrary external tool
results is not inferred.

## Durable retained-context boundary

Each model turn records its authorized-memory snapshot in the existing session log.
The checkpoint contains hashes, not another copy of fact text. Before the next turn,
removed or reclassified facts, changed eligible audiences/policies, or a disabled
recall source advance a durable replay cutoff. Simple fact additions preserve history.
The automatic recall body and its checkpoint are derived from the same filtered heads.

A reset excludes the whole earlier model context, not just matching strings: user
environments, summaries, assistant paraphrases, tool results and historical tape.
Native harness state is reset, stale retry answers and approvals cannot replay, and
background summaries started before the boundary are discarded. Human transcript and
administrator audit records are not erased. The next model turn receives current
memory and begins a fresh context window. This is next-turn invalidation, not live
cancellation of an already executing model request.

Explicit memory reads, searches and history requests can return facts absent from the
starting snapshot. Before returning those results, tools and capability APIs increment
a durable session read epoch without taking the turn lease. A changed epoch triggers
a conservative reset on the next turn even if the notebook later returns to its
original state. This deliberately sacrifices some continuity after explicit reads
rather than retaining untracked facts. The epoch is atomic and restart-safe.

Model-facing history and conversation APIs enforce the boundary. Untracked legacy or
incompatible target conversations are unavailable to those APIs; human transcript
views remain unchanged. Derived titles, status text and pins are not used to bypass
an unavailable agent transcript. Session coordination uses safe identifiers when a
prior title cannot be justified against the current memory snapshot.

## Qualification and limits

Synthetic regressions cover capture failures, inherited restrictions, copying,
classification changes, audience changes, source revocation, restart/compaction,
explicit off-snapshot reads, provider routes and agent transcript reopening. Local
Postgres tests cover migrations, concurrent read epochs and checkpoint persistence.
A launched development portal exercised the actual web/core/worker/Postgres path and
verified that a withdrawn sentinel disappears from the next captured model request
while remaining in the human audit transcript. That routing test used the mock model.
A separate live-model smoke test exercised benign, medical and secret classifications.

Live Slack and every real provider harness have not been qualified. Direct MCP tools,
explicit administrator inspection, exported files and other independently authorized
artifacts are separate access paths. This is not retroactive deletion of copied data,
a guarantee of classifier accuracy, or a complete provenance system for all tools.
