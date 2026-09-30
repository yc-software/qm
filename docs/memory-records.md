# Memory records and audience isolation

## One notebook representation

Built-in memory uses versioned records: stable ID, text, sensitivity, source
scope/session references and an incomplete-provenance flag (`sourceUnknown`).
Markdown is the rendered editing/display format, not a second source of truth.
Headings and freeform prose are records too.

Postgres stores the authoritative snapshot in `memory_revisions.records`. New
revisions derive `body` from those records for compatibility. A legacy revision
with NULL records imports its body as unknown-source records; its sources are never
guessed from where the notebook happens to live. An older writer during a rolling
deployment can still produce a NULL snapshot, which takes that conservative path.
The additive migration preserves existing revisions.

The workspace backend stores one JSON snapshot at its existing reserved memory
path. Existing Markdown is imported on read and migrated on the next write. The
memory API still returns Markdown. Malformed structured data fails closed rather
than silently falling back to potentially stale text. Old file-only binaries cannot
read the new snapshot format; export through the memory API before downgrading one.

## Capture and curation

Automatic extraction classifies each batch as `ordinary`, `unknown`, `sensitive`
or `restricted`. Explicit capture uses the same labels. Missing or malformed
classification and model failure produce `unknown`. Classification is a model
estimate, not proof of harmlessness.

Runtime context supplies source scope/session, never model-authored source claims.
Captures inherit known input restrictions. Untracked history, tools, attachments
or incomplete dependencies add unknown provenance. Cross-scope personal copies keep
their original source. Duplicate capture can tighten metadata without adding text.

Built-in consolidation edits records by stable identity under a revision check.
Each model request sees only facts with identical sensitivity and provenance;
updates and additions inherit that group's metadata. Unchanged records keep their
IDs and metadata. Separate-source facts never share a consolidation prompt.
Bookkeeping is a snapshot counter, not a Markdown marker that rewrites every fact.
A concurrent edit wins over a stale consolidation. Opaque providers retain control
of their own consolidation; generic whole-Markdown automatic rewriting is removed.

An arbitrary whole-notebook rewrite cannot establish which facts its new text
came from. It conservatively inherits the old notebook's combined restrictions.
Restoration likewise inherits the restrictions of all intervening revisions.
Neither operation declassifies information. Clearing removes current content, not
historical revisions.

## Fresh reads

One disclosure view serves recall snapshots, search, primitive tools, memory-file
redirects and agent memory APIs. Provider routes apply it per provider. Structured
search runs over filtered records, not an unfiltered provider query.

The actor must retain access to every recorded source. Carrying memory into another
conversation requires current Open policies at both ends and a known destination
audience. An ordinary personal fact can follow its owner into an eligible internal
Open room; sensitive or restricted facts require every recipient to be entitled to
the sources. Ordinary does not mean public. Unknown provenance stays within the
notebook's existing narrow audience. Lookups fail closed, and authorization results
are not cached between reads.

A partially visible notebook cannot be rewritten. Structured edits require a
revision check. Historical reads apply a conservative restriction floor from newer
revisions; restore checks the complete intervening history in storage.

Opaque external providers and the optional scratch-promotion workflow remain
compatibility paths, not sources of trusted cross-context provenance. Their
unclassified content stays narrow. Scratch captures with foreign dependencies and
cross-origin personal copying are refused. Scratch bookkeeping lives in snapshot
metadata, not fact text; a no-change promotion preserves every fact's provenance.
Direct MCP tools and authorized private
administrator inspection are separate access paths.

## Retained working context is separate

Fresh-read restrictions do not erase information legitimately learned by the same
audience. Source revocation, notebook edits or disabling recall do not reset that
audience's conversation.

A durable session checkpoint records the destination/audience identity hash and a
replay cutoff. An actual audience change advances the cutoff: earlier model
history, summaries, native harness state, retries, approvals and historical tape
cannot re-enter the next turn. Later turns retain post-cutoff context normally.
An absent checkpoint establishes a baseline rather than deleting old context.
Project conversations keep their existing member-inherits-history behavior.

Agent conversation APIs and subagent reads also respect the cutoff, including
derived titles and metadata. Human transcripts and administrator audit records
remain intact. Unversioned external prior turns cannot safely be imported after a
cutoff. This is next-turn isolation, not cancellation of a model request already
in flight, nor retroactive deletion of exported or copied artifacts.

## Verification limits

Synthetic tests cover storage migration, metadata-only capture, consolidation,
revision races, restoration, provider routing, fresh authorization and durable
context boundaries. Live HTTP tests use synthetic facts through the real server
and Postgres. Deterministic model responses isolate consolidation behavior; these
tests do not establish classifier accuracy or qualify every real model and Slack
configuration.
