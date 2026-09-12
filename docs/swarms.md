# Agent swarms

A swarm coordinates ordinary QM sessions. The initiating session is its root;
workers have their own durable transcripts, runs, identity, and editable JSON
character/context. The existing authenticated session viewer lists worker sessions
with a `Swarm worker` title. Worker transcripts remain read-only for ordinary messages in the web UI, but the requesting human can allow or deny pending approvals there. Discovery returns their session IDs and portal-relative
`sessionUrl` links. Session activity and results use the normal viewer and run APIs.

## Deployment

Use Postgres for production (`DATABASE_URL`, `SESSION_STORE=postgres`, and
`RUN_STORE=postgres`) and enable the existing sandbox inventory with
`SANDBOX_RESOURCES_ENABLED=true`. Configure the existing Modal backend with
`MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, and the usual deployment-specific Modal
image, application, and storage settings. Workers always request Modal; they never
silently fall back to a different provider. The existing default computer need not
use Modal. Local development requires `jq` and Linux `prlimit` on the core's PATH;
the core container includes them.

The `swarms` durable-map table has its own registered migration,
`durable-map/swarms/0001`. Apply registered migrations through the normal QM deploy
path before starting workers. Memory stores implement the same contract for tests;
they are not a production durability substitute. Swarms are unavailable with
mixed memory/Postgres stores so execution leases and writes share one authority.

## Agent API

These routes appear in `/v1/apis` and work from every harness that can use QM's
self-API. Use the existing `x-agent-capability: $AGENT_API_TOKEN` header. Swarm
operations require a token bound to the current session and a real durable run.
An agent using a token minted during a human turn is still an **agent**, not a
human author. Request bodies cannot set identity, authorization, or provenance.

### Spawn one or a pool

`POST /v1/swarm`:

```json
{
  "action": "spawn",
  "requestId": "initial-pool",
  "count": 3,
  "contexts": [
    { "group": "implementation", "role": "planner" },
    { "group": "implementation", "role": "worker" },
    { "group": "implementation", "role": "reviewer" }
  ],
  "text": "Coordinate a small implementation. Report findings through swarm messages."
}
```

Omit `count` to spawn one; `contexts` also determines the count when provided. A
single `context` supplies the same initial JSON to every worker. Context may be any
JSON value, not just a role object. `contexts` must match the requested count.
The root is enrolled on the first spawn; workers can recursively call the same API.

The response is `202` with reserved members. A durable outbox provisions their
computers, creates sessions, adds the original participants, and queues initial
turns. Discovery shows `reserved`, `ready`, or `failed` and any provisioning error.
Restarts resume the same reservations rather than allocating another computer.
Provisioning gets three attempts. Terminal failures retire owned computers and
remove empty sessions; unresolved cleanup remains recorded and retried. Failed
reservations still consume the finite lifetime agent budget, preventing unlimited
provider creation/retry loops.

Each worker gets a dedicated **blank** Modal computer owned by the parent's
authorization scope. No parent files are copied. Data access, keychain policy,
memory resolution, and approval grants continue through QM's existing scope and
identity rules, with unattended rather than human-attended permissions. Session
grants belong only to the session that received them, not its workers. A computer's backing storage key
is not an authorization principal. Existing provider persistence behavior is
unchanged; swarms add no filesystem snapshots, immutable copies, or restores.

To add a shared forum, supply `forumSandboxId` naming an existing authorized sandbox
in the same scope. Every worker still gets its own blank private Modal computer.
The forum ID appears in peer metadata and the worker prompt; select it explicitly
with `execute`'s `sandbox_id` for commands that should use the shared computer.
This is not a new filesystem synchronization feature. Workers using a forum share
that disk and must coordinate concurrent writes themselves. Failed worker creation
never retires the existing forum.

### Identity, peers, and character

`GET /v1/swarm` returns `id`, `self`, `peers`, `limits`, and `expiresAt`. Peer
records keep trusted IDs, ancestry, session links, storage selection, and lifecycle
state separate from arbitrary `context` data. Only this swarm is listed, not every
session with the same owner, and never all private sessions in the organization.

`POST /v1/swarm` with `{"action":"context","context":{"role":"reviewer"}}`
replaces the caller's own context. There is no update-other-peer operation. The
character is supplied to the harness as untrusted metadata on subsequent turns.
Setting fields such as `id`, `scopeId`, or `depth` in context changes no authority.

### Messages and audience selection

`POST /v1/swarm`:

```json
{
  "action": "send",
  "requestId": "review-request",
  "audience": ".[] | select(.group == \"implementation\" and .role == \"reviewer\")",
  "text": "Please check the proposed change and reply with your findings."
}
```

The response includes a durable message `id` and monotonic per-swarm `seq`.
Filters run over **eligible, ready peers only**. Each input object has the context's
top-level fields, the original value under `context`, and a trusted `id` that
overrides any identically named metadata. Emit peer objects (`.[]`), not arbitrary
IDs. A filter cannot select sessions outside its eligible input set. Duplicate
selections collapse into one recipient, and an empty selection is valid.
Stored context is preserved verbatim as JSON, including keys or characters that
Postgres JSONB otherwise normalizes. The jq view replaces unmatched Unicode
surrogates with the replacement character so one malformed string cannot prevent
other peers from receiving messages; stored context is not changed.

Messages record intended recipients, author kind, authenticated actor, sender
agent identity (`senderId`), ordinary QM session (`senderSessionId`), and optional
`replyTo`. Other authorized swarm members can read
them even if they were not in the intended audience. Root and worker participant
rosters must remain the original roster; changes fail closed. Current scope and
identity authorization is rechecked before access and execution.

Notification state is persisted as `pending`, `queued` with a durable `runId`, or
`failed`. A queued notification means the run was accepted, not that the agent has
finished. Idle recipients wake through the normal durable worker queue. Active
recipients receive queued unattended turns, not forged human steer signals.
Notification enqueue uses a stable deduplication key so a crash between enqueue
and acknowledgment does not enqueue another run. Agent-only turns have no Slack
delivery target, and the delivery layer also refuses swarm result delivery.

Set `notify:false` for a durable message without a wakeup. Sending to oneself does
not wake oneself. There are no automatic reply-to-reply notifications: agents
explicitly decide whether a response warrants another turn. Every generated turn
consumes the same finite notification budget.

### Ask, read, and tail

`GET /v1/swarm?read=1&after=0&waitMs=0` returns at most 32 messages. Advance `after`
to the last `seq` to tail without rereading prior pages. `waitMs` may be at most
10,000; a timeout returns an empty `messages` array, not a fabricated response.

To ask, send a message, keep its `id`, then read with `replyTo=<id>&waitMs=10000`.
The responding agent sends with `replyTo` set to that ID. Replies can use
`notify:false` when the requester is already waiting. Waiting does not hold a
swarm transaction, provision lock, or other agent's run lease. It does not promise
an answer: an active recipient may finish its current turn first, and mutually
waiting agents time out rather than holding each other indefinitely. Prefer
asynchronous work over nested waits when the worker pool is saturated.

`requestId` is required for spawn and send, at most 128 bytes. Retry the **same
payload and requestId** to get the original reservation/message. Reusing a key
with different content fails. Context updates are simple replacements.

## Human API

Human callers use `GET` and `POST /v1/sessions/:id/swarm` through the existing
source-authenticated API with a signed portal identity. The caller must already
be allowed to view that session and belong to the swarm scope. Request actor
and provenance selector fields are rejected rather than ignored. Arbitrary keys
inside `context` remain permitted. Bodies and read parameters match the
agent API. Initializing a root from this endpoint additionally requires a `runId`
belonging to that session and actor. Human-origin actions are separately recorded;
their asynchronous notifications still run unattended.

Agent operations require credentials bound to the exact session, run attempt, and
unexpired execution lease. Swarm writes recheck that lease inside their database
transaction; credentials from replaced attempts cannot authorize new work. Completed, failed, queued, and expired runs cannot authorize agent swarm
operations. Authenticated human initialization may reference a historical run.
Worker sessions never inherit the root session's command or security-screen
approval grants; a worker must obtain its own approval. Auto screening receives host-verified swarm delegation provenance, so routine delegated tasks and in-swarm reporting are distinguished from external instructions. Delegation does not authorize credential disclosure, permission changes, or overriding higher-priority instructions; those remain screened. Frozen swarm roster checks
apply to swarm notifications, not ordinary human follow-ups in the root session.

Each outbox sweep selects at most 16 pending swarms and reconciles resources for at
most four concurrently, advancing through pending pages so failed cleanup cannot
monopolize the batch. Notification delivery uses a separate four-slot pool and
per-swarm lock, so ready recipients can receive work even when all resource slots
are occupied. Each phase has a 30-second reconciliation deadline and each provisioning
attempt has a 10-second deadline. A timed-out worker fails without receiving work;
its private-resource cleanup remains durable and retries on later sweeps, including
after a late provider completion. The explicitly shared forum is never retired by
worker cleanup. Unsettled operations retain their execution slot and swarm lock
until their side effects finish; timeout never permits overlapping cleanup or
unbounded provider calls. A later process can retire stale provisioning after the
original process releases its locks or exits. Providers that never settle leave
cleanup pending rather than being treated as successfully cleaned up; four stuck
resource operations exhaust only this instance's resource capacity until a slot is
released. Pending selection remains single-flight until its underlying database
query settles, even when a sweep reports a selection timeout.

## Enforced limits

| Resource                                             | Per-swarm limit                                             |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| Total agents, including root and failed reservations | 32                                                          |
| Recursive depth below root                           | 4                                                           |
| Spawn requests                                       | 32                                                          |
| Messages, including initial work                     | 128                                                         |
| Notifications, including initial work                | 256                                                         |
| JSON context / message body                          | 8,192 UTF-8 bytes each                                      |
| Work window                                          | One hour from first spawn                                   |
| Per-notification turn                                | 120 seconds; cancellation also enforced by the worker       |
| Run retries                                          | Two error attempts; no harness execution after three claims |
| Read page / maximum wait                             | 32 messages / 10 seconds                                    |
| jq program / input / output                          | 2,048 / 512,000 / 512,000 bytes                             |
| jq wall time / CPU / address space                   | 500 ms / 1 second / 128 MiB                                 |
| Concurrent jq processes per core instance            | 4                                                           |

The database atomically reserves budgets with the messages/members that consume
them. Invalid or exhausted operations do not partially reserve work. jq runs with
an isolated environment, no file arguments, disabled module loading, bounded
output, and OS resource limits. Invalid programs, module imports, resource
exhaustion, and unsupported evaluator hosts fail closed.

After expiration, history remains readable, but new work, notifications, and
character changes are rejected. Human-initiated ordinary session turns remain
ordinary QM actions. Workers and their durable results remain visible; computers
can be retired through the existing sandbox inventory. There is no automatic
filesystem export on retirement: publish useful outputs through existing Files
or your version-control workflow first.

## Verification

Run the focused suites with `node --experimental-test-module-mocks --test test/swarm*.test.ts`.
Run `npm run test:pg` against a disposable Postgres database. The swarm suite uses
a separate schema so migration-reset tests cannot invalidate its state.
Set `SWARM_TEST_DATABASE_URL` when running `test/swarm-orchestrator.test.ts` to
exercise the HTTP spawn/reply flow across an application restart with real durable
state. These tests use deterministic model and Modal doubles; live provider and
model acceptance remains a separate deployment check. The agent-board UI is
intentionally deferred.
