# The Tape: one session log, model-view first

_Phases 1–2 are implemented; tape serving is the default._

## The problem, in one paragraph

Today a conversation is stored as a human-readable _retelling_ (`session_entries`),
and the thing the model actually needs — its own prior context — is re-derived from
that retelling by lossy reconstruction (`replay.ts`), patched over by an in-RAM warm
cache (`pi-harness.ts` cache Map), and shadowed by a third copy kept for debugging
(`session_llm_requests`, the verbatim prompts). Three representations of one
conversation, none authoritative for the model. Every bug class we've hit here —
stale-RAM divergence, lost steer messages, confabulation forensics needing
`session_llm_requests`, prompt-cache misses on "unlucky server" — is a symptom of
the model's view being derived instead of stored.

## The invariant

> **The model reads only what the tape (plus the turn's resolved system prompt and
> toolset) contains, and the tape contains everything the model read — in the order
> it read it.**

There is no side channel into the model's message context. Review forced two honest
scope notes on the slogan:

- The **system prompt and tool schemas** sit outside the message array. They are
  captured per turn (see _Forensics_), but they are resolved fresh each turn, not
  replayed from the tape.
- Context assembly is **audience-parameterized**, not a function of the tape alone:
  today's model context is filtered per turn by who's listening
  (`filterHistoryForAudience`, orchestrator.ts:1046/2532 — a personal-scope tool
  result recorded inside a channel session is excluded from channel-audience turns;
  test/scope-reach.test.ts pins this). So: `context = fold(tape, audience)`. Same
  tape + same audience ⇒ same bytes. Dropping the filter would leak DM content into
  channels; the spec keeps it.

## The design

One append-only Postgres table per conversation stream — the **tape**. A record is
one of three kinds:

| kind            | what it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | in model context?         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `message`       | one harness-native message, **verbatim as the live turn consumed or produced it** — including provider stamps (`api`/`provider`/`model`), thinking blocks + signatures, tool calls/results, and the environment footer as a tagged block. Each row is stamped with the **harness** that wrote it (`pi` \| `opencode` — the harness is now pluggable); the fold replays same-harness rows verbatim and converts a foreign-harness prefix through an explicit `harness_change` event, exactly like `model_change` | yes, audience-permitting  |
| `context_event` | an explicit durable edit: `compaction` (replace seqs ≤ n with a summary), `redaction`, `interrupt` (heal a dangling tool call), `model_change` / `harness_change` (lossy-conversion markers), `legacy_import` (replace everything before me with a frozen reconstruction), `legacy_patch` (append a reconstruction of an entry range the tape missed — the coverage heal)                                                                                                                                       | yes — applied by the fold |
| `annotation`    | bookkeeping the model never sees: approval requests/resolutions, overheard-import watermarks, per-turn resolved-prompt capture                                                                                                                                                                                                                                                                                                                                                                                  | no                        |

Every `message` row also carries **structured metadata columns**, because five
subsystems key on fields, not rendered text (review F: resume, overheard dedup,
approval replay-hiding, previews, wake cursor): `scope_label` (audience filtering),
`bare_text` (the human's text without the env footer — resume/approval equality
checks read this, never the folded text), `ts`/`change_time` (surface dedup + wake
cursor), `hidden`, `overheard`, `author`. Renderers and SQL rollups read columns;
the model reads the verbatim payload. This metadata sidecar is the honest price of
retiring `session_entries` — the semantic layer shrinks to columns, it doesn't
vanish.

Context assembly:

```
context(tape, audience) = fold(rows in seq order)
  message        → include verbatim iff audience entitled to row.scope_label
  context_event  → apply (replace / patch); compaction & legacy_import record
                   which audience-view they summarized
  annotation     → skip
```

Deterministic given (rows, audience). No I/O, no RAM state, no repair heuristics —
because ordering is guaranteed at write time, not fixed up at read time (next
section).

### Writes: consumption order, synchronously

Review found two mechanisms in today's writer that would corrupt a verbatim fold:
entry persists ride async chains that race for seq (a fast tool result can commit
before the assistant message carrying its tool_use — session-store.ts's own
`persist` note), and steers are persisted at _arrival_ though the model consumes
them at the next step boundary (pi-harness.ts:1599). Both are repaired today by
`replay.ts`'s reorder-and-pair pass — the exact code this design deletes. So the
tape changes the write contract:

- **The harness appends tape rows at step boundaries, in consumption order,
  synchronously** — the loop does not dispatch step N+1 until step N's rows are
  committed. A failed append is turn-fatal (today a swallowed persist silently
  drops a thinking block; under the tape that would be a silent byte-divergence
  forever — fail loudly instead). Cost: one Postgres round-trip per step, ~1–5ms
  against a 20s p50 step; measure, don't assume.
- **Steers append where they're injected** (the step boundary), with an
  `annotation` stamping arrival time for audit.
- **Compaction appends carry a monotonicity guard**: an event whose replaced range
  is ≤ the latest applied one is rejected at append (inside the lease-checked
  transaction) — today's background pass can plan from a stale snapshot and would
  otherwise resurrect evicted history.
- **Annotations are exempt from the writer lease** (delivery receipts and approval
  resolutions are written by other instances while a turn holds the lease for up
  to 30 min; fold skips them, so lease-free append is safe). `message` and
  `context_event` rows require the lease, same token-fenced append as today.

### A turn

```
1. take the per-session writer lease  (existing code, unchanged)
2. rows = SELECT tape; ctx = fold(rows, audience)
3. if this is a RETRY of a reaped run whose user message is already the trailing
   turn on the tape → do not re-append it; append `interrupt` if a tool call
   dangles; prepend the resume note ("outcome unknown, don't redo side effects")
4. else append the user message (bare_text + env footer as tagged block)
5. loop: call model; append response rows; run tools; append result rows —
   each step's appends committed before the next dispatch
6. release the lease
```

Step 3 is not optional polish: without it, a deploy-killed cron run re-appends its
user message on retry and the model redoes the whole turn's side effects — the
exact class `turn-resume.ts` exists to prevent (review F3, concurrency pass).

### Rendering is a projection

Slack transcripts, the admin UI, and the History rollups read the same rows via
the metadata columns. Today's entry types become render rules. Existing
seq-keyed joins survive because **during dual-write each tape row records the
`session_entries.seq` it mirrors**, and post-cutover the tape's own seq continues
that numbering — `turn_metrics.turn_seq`, delivery provenance, and admin deep-links
keep working. `forkSession` (web-ui fork/cut) copies
a viewer's folded projection into a fresh tape as a `legacy_import` event — the
one sanctioned projection→tape path.

Delivery receipts today re-enter the model's context only on cold replay (a
live-vs-replay divergence, and an agent-voice confabulation source —
replay.ts:190). Under the tape, a delivery appends a proper `message` row (a
system-authored note) once, durably: the model always knows what was delivered,
in the same bytes, warm or cold.

### Forensics

"The tape is what the model saw" is true for messages but NOT the whole request:
the resolved system prompt (reach hints, memory recall, logins, skills) and tool
schemas are rebuilt each turn and are the thing the debugging runbook actually
checks (`is the hint present in session_llm_requests?`). So:

- Each turn appends an `annotation` with the **resolved system prompt and toolset,
  hash-deduped** (it's near-identical turn to turn; store hash + body once per
  distinct value). This replaces the runbook's dependency on request bodies.
- `session_llm_requests` retires its per-step message-array bodies (the real
  O(turns²) storage cost) and keeps usage/latency/gap-phase telemetry. Existing
  pre-migration rows are frozen, not dropped — they're the only faithful record of
  the pre-tape corpus.

### Images

Neither store holds image bytes today (`session_llm_requests` redacts them; cold
replay silently drops them — so today's cold turns literally lose the pictures).
The tape stores image blocks as **references into the existing artifact/file
store**; fold rehydrates bytes at assembly. Verbatim-by-reference keeps the
invariant without putting megabytes of base64 in every future context read, and
fixes the images-vanish-on-cold-start behavior as a side effect.

## What this buys — the honest version

Review (provider-reality pass) cut the original claim down. The tape makes rebuilt
context **byte-identical to the live continuation** — eliminating the measured
~57k-token / ~7s penalty class on rebuilds. It does _not_ make Anthropic's prompt
cache hit unconditionally, because the cache key also spans things the tape doesn't
control, and this system varies them per turn:

- `speed` (fast mode) and thinking-level flips — cron/heartbeat turns force
  `xhigh`+slow while interactive turns run fast+low (`turn-options.ts`); each flip
  inside one conversation busts the message cache regardless of bytes;
- toolset churn (readOnly / surfaceTools / skills-catalog changes) and the volatile
  system-prompt sections (logins, connected apps) — upstream of messages in the
  cache prefix;
- the 5-minute cache TTL (1h split is staging-only today) — idle conversations
  re-read regardless;
- the OpenAI provider keys its cache on a per-process random session uuid
  (`SessionManager.inMemory()` → `prompt_cache_key`) — must become a durable id
  derived from the conversation, or GPT-org turns never chain at all.

Fixing those is scheduled alongside the migration (see _Cache fast-follows_) —
the tape makes the bytes stable; the fast-follows make the provider honor them. What the tape does delete outright:
`replay.ts` reconstruction + preamble fallback, the warm cache (`CacheEntry`,
`consumedSeq`, eviction, material fingerprint, temp-dir leak class, the
warm-flags-mismatch lost-turn class), request-body capture, the lost-steer bug,
and the lucky-server _byte-divergence_ component (both instances send identical
bytes; a content-keyed cache treats them alike).

Byte-identity is asserted where it matters: the phase-2 gate property-tests the
**wire payload** (`buildParams` output), not the Pi message array — the SDK's
cross-model transforms key on per-message provider stamps, so stripped stamps
would silently re-shape history (review F4, provider pass). Note the guarantee is
per-SDK-version: a blue-green window running two pi-ai versions may serialize the
same tape differently for its duration — accepted, bounded, and true of the warm
cache today too.

## What stays

- **The writer lease** — concurrency, not caching; 60 lines, unchanged. Known
  sharp edge inherited from today: the lease renews only on appends, so a >5-min
  silent model step can let a second instance steal the session mid-turn. The
  tape's token-fenced appends keep the log untorn (the loser's writes fail), but
  the `interrupt` event can mis-describe work that later completed. Same exposure
  as today; noted, not solved here.
- **Compaction**, as a first-class guarded event. It intentionally breaks the
  provider cache (content really changed) — rare and correct.
- **Sizes are fine.** p50 session 5KB / p90 46KB; fold is sub-ms. Per-turn session
  construction (`createAgentSession` + temp resource dir) replaces the warm cache
  on every turn — today's measured cold cost is 1–10ms `compile_ms` plus
  unmeasured SDK wiring; phase 2's rollout measures it before deleting the cache
  (a memoized fold keyed on `(sessionId, maxSeq, audience)` is the fallback,
  correct by construction, only if numbers demand it).

## Cache fast-follows — pulled into the plan

The tape makes the bytes stable; four pre-existing cache busts (they cost us today
too, warm or cold) decide whether the provider honors them. Rather than ship the
tape and leave the wins on the table, they ride the migration:

| #   | work                                                                                                                                                                                                                     | size                                                                                   | ships with |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------- |
| FF1 | Prod cache config: `PI_SYSTEM_CACHE_SPLIT=1` on the AWS task defs (staging-only today) + extended cache retention (1h) if the SDK knob confirms out                                                                      | config-only                                                                            | phase 1    |
| FF2 | OpenAI durable cache key: derive `prompt_cache_key` from the conversation id instead of the per-process random uuid (`SessionManager.inMemory()`)                                                                        | small PR                                                                               | phase 1    |
| FF3 | Settings stickiness: a triggered turn running _inside a conversation session_ inherits that session's speed/thinking instead of forcing slow+xhigh (`turn-options.ts`) — cron monologue sessions keep their own settings | small PR + a product call (do in-conversation wakes lose deep thinking? proposed: yes) | phase 2    |
| FF4 | Prompt-prefix hygiene: volatile system-prompt sections (logins, connected apps) ordered below the cache boundary; audit per-session toolset stability                                                                    | medium                                                                                 | phase 2    |

## Migration

The deploy environment is the threat model: 2 instances, blue-green, a deploy on
every merge, and reverts are routine. The review's migration pass found the
original plan's backfill and rollback stories broken; this version is rebuilt
around one mechanism:

**`legacy_import` is a lease-held, coverage-watermarked, replace-semantics event.**
It records `covers_entry_seq = W` (= `MAX(session_entries.seq)` read in the same
lease-checked transaction) and means "discard all tape rows before me; my payload
is the reconstruction of entries ≤ W." Idempotent and re-runnable by construction.

1. **Dual-write + backfill** (one PR). Turn writers append tape rows (each stamped
   with the entry seq it mirrors) alongside entries. Tape DDL joins the existing
   idempotent boot preamble (CREATE IF NOT EXISTS only — **never** data writes in
   the boot path; the turn_metrics DDL-abort incident is the precedent). The
   backfill is a standalone, dry-run-first, re-runnable script run via ECS exec,
   acquiring each session's lease (skip-busy-and-retry). Blue-green windows where
   an old-code instance writes entries-only are expected, not exceptional — healed
   below.
2. **Read cutover.** Shadow mode folds and logs without serving; serve mode uses a clean Pi fold
   and otherwise falls back to entry reconstruction. Context is `fold(tape, audience)` only after
   full coverage, audience filtering, same-harness validation, structural lint, bounded image
   rehydration under current artifact grants, and a 500-entry read bound. Project sessions remain
   on reconstruction because their membership-tenure windows do not yet have a tape projection;
   foreign-harness tapes likewise remain shadow-only pending `harness_change` conversion. Tape
   write failures withhold the coverage watermark rather than failing an otherwise deliverable
   turn. **Coverage gate:** while
   entries still exist, the read path compares `MAX(entries.seq)` against the
   tape's coverage watermark; a tape missing anything (rollback window, missed
   dual-write, failed mirror) is never served as-is — the read re-imports it
   under the turn's lease (a `legacy_import`, the same event the backfill
   writes, same fidelity trade) and serves the healed fold, so coverage
   converges instead of latching broken. Entries the turn itself appends before
   the read (overheard imports, file events) are witnessed appends the turn-end
   watermark covers, not gaps. The watermark is honest by construction: never
   advanced past a turn whose tape writes failed, whose mid-turn steers never
   reached the tape, or whose coverage was still broken at serve time. The
   other durable heal is the `interrupt` event for dangling tool calls; an image
   artifact that is missing, disabled, or invalid leaves its fold unservable
   and falls back to reconstruction, while one whose bytes were never captured
   or no longer fit the read budget folds to a placeholder.
   A reply-or-decline continuation rereads and serves the tape extended by its first
   sub-turn only when that sub-turn served a clean fold, every append succeeded, and a
   terminal checkpoint proves the reread contains the complete sub-turn; otherwise it
   reconstructs — the watermark still advances when every append succeeded, because it
   is a write-completeness claim, not a served-fidelity one.
   `replay.ts` and entry dual-writes therefore **survive through phase 2** as
   the fallback path; the warm cache is deleted here. Gates:
   - wire-level byte-identity property test (fold → `buildParams` bytes equal the
     live turn's captured bytes, over real prod tapes);
   - prefix-stability property test over `message` appends, plus golden-file
     semantics tests per event kind (events exist to break prefixes — testing
     them as prefix-stable would be vacuous);
   - approval continuation after a fold-only rebuild: the blocked
     tool_call/result pair is in context, the grant authorizes without
     re-carding, and the replayed input is detected (via `bare_text` equality)
     and hidden — note today's flow _re-decides_ by design; the gate asserts the
     continuation semantics, not a mechanical re-execution;
   - mid-turn-deploy retry: reaped run resumes without re-appending its user
     message or redoing side effects.
3. **Projection cutover.** Renderers (admin SPA, web-ui bridge — a cross-package
   wire contract, coordinate the release) move to tape projections. Entries stop
   being _read_ but keep being _written_ for one more release (rollback depth = 1
   phase, enforced by keeping the previous phase's write path alive one release
   past its read cutover); then a cleanup PR retires entry writes and
   `session_llm_requests.request` for new rows. Pre-migration request bodies and
   entries are frozen, never dropped.

## Resolved questions

- **Participant-scoped visibility** (`visibleEntries`): per-viewer projection
  filter on the metadata columns, same time-window semantics (tape rows carry
  `created_at`). Distinct from the _audience_ filter inside fold, which is part
  of model-context semantics, not rendering.
- **Thinking-block retention**: not a new exposure — thinking is already durable
  in `session_entries`; the tape only adds replay. Retention sweep treats tape
  rows like entries. One genuinely new surface: tape rows (signatures, image
  refs) flow into the /stage prod-snapshot pipeline — the snapshot's existing
  llm-request exclusion extends to the resolved-prompt annotations.
- **Legacy sessions**: eager backfill via `legacy_import` (above). The frozen
  reconstruction is lossy (no thinking, pre-callId tool I/O dropped) — accepted;
  it's exactly what cold starts feed the model today, and the corpus is weeks old.
- **Stale environment facts**: recording the env footer means yesterday's roster
  note replays forever, where today's cold rebuild silently dropped it. Accepted:
  it is what the model saw (that's the invariant), each turn appends a _fresh_
  footer that supersedes it in practice, and `redaction` events cover the sharp
  case (revoked shares). Injected content in old footers is no worse than
  injected content in old user messages.
