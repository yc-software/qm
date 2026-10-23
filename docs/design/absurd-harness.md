# QM turns on Absurd, and the harness as its own service

Status: accepted direction (Regan, 2026-10-20 2:37 PM PT). Decisions are recorded below. Items marked _default, changeable later_ are the starting settings and are not settled forever.

## Summary

QM's run queue (`src/runs/`) is a hand-built durable-execution engine with claims, leases, heartbeats, a reaper, retries, preemption, signals, and a deploy-ownership protocol. This design replaces that engine with Absurd while keeping QM's own record of turns, and moves turn execution out of the API process into a separate harness service.

- **One turn, one task.** Each turn is one Absurd task.
- **One active turn per conversation.** A pointer on the session row (`sessions.active_turn_id`) enforces this when a turn is created, not when a worker claims it. Input that arrives while the conversation is busy becomes a steer (a `SteeringMessage` item) or queued input that the turn-end transaction starts next. Absurd queues therefore hold only runnable turns, and no claim checks sibling runs.
- **Priority.** Three queues (people, delegated, background) carry priority.
- **Content stays in `items`.** `items` is the only record of what a turn did. Absurd stores no transcript.
- **Separate harness service.** API and Slack deploys never touch a running turn.
- **Deploys never wait for turns.** On SIGTERM the harness hands every turn back to the queue at once, and the incoming instance resumes it from items.

## Why now

- QM is about to run swarms of hundreds of subagents and work that lasts several days. Today's engine scales poorly for both.
  - **Claim cost.** On Oct 20 the run claim was most of production database CPU (Performance Insights: 0.48 of about 0.75 average active sessions). About 99.7% of claim calls found nothing. Most of the cost was query planning for the per-session sibling check, repeated by every idle worker on every wake-up. #2488 (merged 2:34 PM PT today) cut both. The structure remains, and its cost grows with swarm size.
  - **Fan-in cost.** A parent hears about each child separately, so N children cost N parent turns.
  - **Waiting holds a worker.** A turn that waits keeps its worker slot the whole time.
- Session history moved to `items` on Oct 19. Turn content now lives in one append-only table keyed by `(tenant_id, session_id, seq)`, with `turn_id` on every row, which makes "the transcript is the checkpoint" practical.
- Absurd (earendil-works) is the durable-execution layer already chosen for qm-crystal. Temporal is ruled out and DBOS was rejected.

## Terms used here

- **Turn**: one unit of agent work in a conversation. It starts from input (a message, a cron fire, a child result) and ends with a reply or a stop. Today a turn is a row in `runs`; after cutover the table is named `turns`.
- **Absurd task / run**: a _task_ is the logical job; a _run_ is one attempt at it. A new run is created only when an attempt fails. Sleeping and waking keep the same run.
- **Claim / lease**: a worker takes a run for N seconds (`claim_timeout`) and must extend the lease (`extend_claim`), or another worker may take the run over.
- **Fencing**: every write a turn makes first checks that this worker still holds the lease. A worker that has lost the lease, because it was killed, partitioned from the network, or handed the turn back, cannot corrupt the turn's record.
- **Suspend**: a run gives up its worker and goes to `sleeping` until a time (`schedule_run`) or a named event (`await_event`). No process holds it while it sleeps.
- **Event**: a named, one-shot message inside one Absurd queue. The first emit wins and is cached, so a waiter that arrives late still sees it.
- **Harness**: the code that runs a turn: the orchestrator, model calls, tools, and the pi/Claude adapters. Today it runs inside `core`.

## What Absurd actually provides (verified against the SQL)

Read from `migrations/0001_absurd.sql` in qm-crystal (0.5.0) and upstream `sql/absurd.sql` (0.5.1, released 2026-10-20 4:07 AM PT).

| Fact                                                                                                                                                                                                     | Consequence for QM                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Each queue is a set of five tables (`t_`, `r_`, `c_`, `e_`, `w_`). `claim_task` orders by `available_at, run_id`; there is no priority column.                                                           | Priority needs separate queues and a worker that prefers one of them.                                                                                                    |
| `spawn_task(queue, name, params, {idempotency_key, max_attempts, retry_strategy, cancellation})` has no dependency (`after`) option.                                                                     | qm-crystal's `docs/PROTOCOL.md` line "spawn_task with `after=<turn_id>`" describes a feature that does not exist. QM provides turn ordering through the session pointer. |
| All functions are plain SQL. `spawn_task`, `complete_run`, `schedule_run`, and `emit_event` can run inside the caller's transaction.                                                                     | Creating a turn, ending a turn, and starting the next one are each one transaction across QM tables and Absurd.                                                          |
| `await_event(queue, task, run, step, event, timeout)` waits on exactly one event name. `emit_event` wakes waiters **in the same queue only**. Event names are first-write-wins and cached until cleanup. | Fan-in needs a counter that emits one event. An emitter must target the waiter's queue. Each suspension uses a fresh event name.                                         |
| `schedule_run(queue, run, wake_at)` moves a running run to `sleeping` without using an attempt, and clears `claimed_by`. A sleeping run whose `available_at` has passed is claimable.                    | Deploy handback and parking are both `schedule_run(run, now())`. No retry is spent, and any worker can resume the run.                                                   |
| An expired lease is noticed only inside `claim_task` (a bounded sweep per call). The sweep calls `fail_run`, which uses an attempt and creates a new run.                                                | A hard kill before handback costs one attempt, so `max_attempts` must allow for that. QM keeps its own error budget.                                                     |
| `set_task_checkpoint_state` and `await_event` reject failed or cancelled runs. They do **not** check which worker holds the claim.                                                                       | QM fences its own writes, item appends included (section 2).                                                                                                             |
| `cancel_task` cancels one task. A worker learns about the cancel only when its next Absurd call raises `AB001`.                                                                                          | Cancelling a subagent tree is QM's job. A prompt stop also needs a notification.                                                                                         |
| Up to 0.5.0, every `claim_task` scanned the whole task table for cancellation rules, with no index. 0.5.1 adds the index (upstream #140).                                                                | Pin 0.5.1.                                                                                                                                                               |
| `enable_cron` schedules Absurd's own maintenance through pg_cron. It is not a user cron.                                                                                                                 | QM's cron scheduler stays. qm-crystal's note about crons through `enable_cron` is wrong.                                                                                 |
| Retention is `cleanup_tasks` and `cleanup_events` by TTL, or weekly partitions in partitioned mode.                                                                                                      | Retention is a periodic call from the harness.                                                                                                                           |

The TypeScript SDK (`absurd-sdk` 0.5.1, about 1,600 lines in `src/index.ts`) provides `step`, `awaitEvent`, `sleepFor`, `heartbeat`, `emitEvent`, and `spawn`. Its worker polls one queue every 250 ms without LISTEN. It calls `process.exit(1)` when a task overruns twice its claim timeout, which would kill every other turn in the process. Its `TaskContext` issues its own queries, so it cannot join a QM transaction. QM therefore uses a thin client (section 8).

## How others do it (reliable knowledge only)

- **Cloudflare Durable Objects / Agents SDK.** One actor per id (for example per agent or per chat), with a single-threaded instance that has storage colocated. An agent instance is a Durable Object, so requests to one agent are serialized by construction. Timers are per-object alarms. Cloudflare Workflows adds durable steps (`step.do`, `step.sleep`, `step.waitForEvent`). _Mapping:_ the session pointer gives QM the "one actor per conversation" ordering without keeping an object alive between turns. Each turn is a short durable workflow.
- **Temporal.** Workflow code is replayed against a recorded event history. Activities (side effects) retry by policy. Workers long-poll named task queues. Signals deliver input to a running workflow, and child workflows handle fan-out. Long-lived workflows need "continue-as-new" to keep history bounded. _Mapping:_ our turn is the workflow, `items` is the history, and a steer is a signal. "A turn ends and a later turn starts" plays the role of continue-as-new. That is the reason one task per conversation is rejected below.
- **Restate.** "Virtual objects" are keyed handlers that run one at a time per key, backed by a journal. That is the same per-conversation serialization the pointer provides.
- **Inngest.** Concurrency limits can be keyed per user or tenant, which is the fairness mechanism mirrored by the per-swarm cap below.

## Today, concretely

Illustrative example: Regan sends a DM while a nightly cron turn is running in the same DM, and a coordinator in another conversation has 40 subagents running.

1. **Enqueue** (`postgres-run-store.ts` `enqueue`): inserts a `runs` row with `status='pending'` and a `claim_priority` from `runPriority`, then sends `pg_notify('qm_run_available')`.
2. **Claim** (`claim`): the candidate query's `NOT EXISTS` sibling subquery rejects any run whose session already has a running or earlier pending sibling. Since #2488, one idle worker wakes per signal instead of all of them.
3. **Run** (`worker.ts` `processRun`): heartbeats every `leaseTtlMs/3` against a 120 s lease. Steers, aborts, and client tool results arrive through `run_signals`.
4. **Priority** (#2356): `createRunPreemption` aborts the newest background run with `PARKED` when a person's turn is waiting and every worker is busy.
5. **Crash or deploy**: the lease lapses, the run is requeued, and `turn-resume.ts` scans items backwards to find the partial turn.
6. **Deploy ownership**: blue and green core stacks share one database. Only the stack named in `background_ownership` claims runs, runs crons, and opens Slack ingress. That involves `background-controller.ts`, `/v1/background-work`, `cli/src/background-work.ts`, and the ownership guards in `cli/src/backends/aws.ts` (most recently #2472). An API deploy is therefore also a background-work handoff.
7. **Subagent results** (`deliverSubagentMail`, `pendingReturns`): every finished child mails its parent. Forty children produce up to forty parent wakes, each re-reading a growing context.

## Design

### 1. What lives where

- **`items`** (unchanged): the only record of turn content and the only step record. No transcript, tool output, or model payload goes into Absurd.
- **`turns`** (today's `runs`, renamed once the legacy engine is gone): one row per turn. It holds the id (= `turn_id` on items), session, request envelope, origin, tier, status, result, delivery state, dedup key, parent turn, and error count.
  - New columns: `engine` (`legacy` | `absurd`), `absurd_queue`, `absurd_task_id`.
  - Statuses: `queued` (waiting for its conversation), `pending`, `running`, `waiting` (suspended), `parked`, `done`, `failed`, `stopped`.
  - API status reads (`activeForThread`, `inFlightForThread`, `latestForThreads`, run-result delivery) use this table and never read Absurd's per-queue tables.
- **`sessions.active_turn_id`** (new, nullable): the conversation's one active turn, whether running or suspended.
- **Absurd**: task params are `{ turnId }`. Checkpoints exist only at suspension points, where Absurd requires a step name, and hold small markers such as `{ "wokeBy": "steer" }`.

**Decision: model and tool calls are not Absurd steps.** Items already provide what a step checkpoint would:

- `ToolCall` and `ToolResult` are unique per `(session, kind, call_id)`.
- `AgentMessage` carries `step`.
- A `ToolCall` with no `ToolResult` is the in-doubt case that resume already handles (`unrecordedToolResult`).

Writing an Absurd checkpoint per step would record everything twice. Resume reads the turn's items through `items_by_turn` and continues. Checkpoint count tracks suspensions (a few per turn), not steps (hundreds per long turn).

### 2. One task per turn, ordered by the session pointer

**Admission** happens in `app-turn.ts`, `session-syscalls.ts`, the cron runner, `swarm-service.ts`, and child returns. It is one transaction:

```sql
BEGIN;
SELECT active_turn_id FROM sessions WHERE id = $session FOR UPDATE;
-- conversation idle:
INSERT INTO turns (id, session_id, engine, status, tier, request, ...) VALUES ($turn, $session, 'absurd', 'pending', $tier, ...);
UPDATE sessions SET active_turn_id = $turn WHERE id = $session;
SELECT * FROM absurd.spawn_task($queue, 'turn', jsonb_build_object('turnId', $turn), jsonb_build_object('idempotency_key', $turn, 'max_attempts', 10));
SELECT pg_notify('qm_turn_ready', $queue);
COMMIT;
```

If the conversation is busy:

- **Steerable input** (a person's message for the same model account, under the existing rules in `app-turn.ts`): it is appended as a `SteeringMessage` item with `turn_id = active_turn_id` and announced with `pg_notify('qm_turn_input', turn)`. The running turn folds it in at its next model step. If the active turn is suspended, admission also emits that turn's current wake event so the turn resumes.
- **Everything else** (cron fire, child result, another account's message, a person writing into an automation turn): a `turns` row with `status='queued'` and no Absurd task.

**Turn end** happens in the turn task after the final reply items are written. It is also one transaction:

```sql
BEGIN;
SELECT active_turn_id FROM sessions WHERE id = $session FOR UPDATE;
-- if a SteeringMessage for this turn landed after the last model step: ROLLBACK and run another model step
UPDATE turns SET status = 'done', result = $result, finished_at = now() WHERE id = $turn;
-- next: a parked turn first, then queued rows by tier, then FIFO; child results batched (section 4)
--   found -> UPDATE sessions SET active_turn_id = $next; spawn_task(...) or emit_event('resume:<next>')
--   none  -> UPDATE sessions SET active_turn_id = NULL
SELECT absurd.complete_run($queue, $run, '{"ok":true}');
COMMIT;
```

The session row lock prevents races between a steer and turn end. A steer either commits before turn end takes the lock, in which case turn end sees it and keeps working, or after, in which case it sees the pointer moved and becomes a new turn. Because `complete_run` is in the same transaction, there is no window where Absurd and QM disagree about whether the turn is done. No claim checks sibling runs: Absurd queues contain only turns that may run now, so a claim is an indexed pick from `r_<queue>(state, available_at)`.

**Leases and fencing (decided)**: takeover uses timed leases plus fencing. It does not depend on any platform proving that a process is dead, so QM stays hostable on Fly, Render, Kubernetes, or a single process.

- **The token.** Each claim gets a unique token stored as Absurd's `claimed_by` (`<process>:<nonce>`). The token is valid only while the run is `running` and `claimed_by` still equals it.
- **Every turn write checks the token.** Item appends, the turn-end transaction, and the capability-token checks that use `runLeaseToken` today (`composio.ts`, `external-slack.ts`, `swarm-fence.ts`) all verify, in the same statement or transaction:

  ```sql
  SELECT 1 FROM absurd.r_<queue> WHERE run_id = $run AND state = 'running' AND claimed_by = $token FOR SHARE
  ```

  A failed check aborts the in-process turn.

- **When a lease ends.** Handback (`schedule_run`) clears `claimed_by` immediately. Lease expiry fails the run and replaces it. Either way, every later write from the old process is rejected.
- **Lease timing.** Normal operation uses a 60 s `claim_timeout`, extended every 20 s (_default, changeable later_). The timeout matters only for processes that die without handing back.

**Deploys and shutdown: SIGTERM hands back immediately; a deploy never waits on a turn.**

1. On SIGTERM the harness stops claiming at once.
2. It aborts every in-flight model call and tool call through their `AbortSignal`s, stops heartbeats, and for each held run calls `schedule_run(run, now())` and `pg_notify('qm_turn_ready', queue)` in one transaction. This takes milliseconds per turn and spends no retry attempt.
3. The process then exits by itself. It never waits for a turn to finish, so a turn several hours long cannot delay a deploy.
4. The incoming instance (or any other harness process) claims the runs within about a second of starting. It reads each turn's items and resumes. An interrupted model call is issued again. A `ToolCall` without a result is resolved by the existing resume rule: the model is told the call was interrupted. A remote side effect that was already running, such as a sandbox command, may have completed. That is the same exposure as today.
5. **SIGKILL** after the platform's grace period (ECS 30 s default, Kubernetes 30 s, Fly 5 s by default) is safe:
   - If handback committed, the killed process held nothing.
   - If it did not commit, the lease expires within 60 s, `claim_task` fails the run (one attempt spent), and a new attempt resumes from items.
   - In both cases fencing rejects anything the old process might still try to write.
6. **Single process** (self-hosted, `QM_ROLES` = all): the turns sit in the queue as runnable runs and resume within seconds of the new process starting.

**Crash mid-turn**: the pointer names the turn, not a worker, so it stays held. The lease expires, the next `claim_task` on that queue fails the run, and attempt n+1 resumes from items. Absurd's `max_attempts` (10) is only a crash-loop backstop. QM's error budget stays in `turns.error_attempts` (3, as today): on the last model or provider error, the task runs turn end with `status='failed'` itself.

**Stuck-pointer repair**: Absurd can fail a task outside QM code, for example when expired leases exhaust its attempts, and an operator can cancel one directly. A sweep every 60 s on the harness leader finds sessions whose `active_turn_id` names a terminal turn, or a turn whose Absurd task is `failed` or `cancelled`. It runs turn end with `status='failed'` plus an `Error` item, which also advances queued input. A partial index on `sessions(active_turn_id) WHERE active_turn_id IS NOT NULL` keeps the scan to busy conversations.

**Rejected: one long-lived task per conversation.**

- It never completes, so it can never be cleaned up, and in partitioned mode it pins its partition.
- Every turn adds checkpoints to the same task forever, and resume reads all of them.
- Each between-turn wake needs a fresh event name anyway.
- Stopping one turn would mean cancelling the conversation, and attempts and retry policy would be shared across unrelated turns.
- Most conversations are idle, which leaves thousands of permanently sleeping tasks.

This is Temporal's continue-as-new problem; the session pointer avoids it.

### 3. Priority: three queues, a preferring claim loop, and parking

Queues: `turns_people`, `turns_delegated`, `turns_background`. Tier comes from the existing `runPriority()`. A person's turn goes to people. A subagent of a person's turn goes to delegated. Crons, loops, swarms, and their descendants go to background.

**Claim loop** (one per harness process, replacing the per-slot loops in `worker.ts`):

- It wakes on `LISTEN qm_turn_ready`, with a 1 s fallback poll for timers and expired leases.
- With `free` open slots, it calls `claim_task` on people, then delegated, then background, asking each for up to `free` runs.
- People claims may exceed the slot count by up to `slots/4`, and each extra slot is paid back by parking a background turn.

**Parking for capacity** (replaces `createRunPreemption` / `personWaiting`): when a people turn is claimed over capacity, the newest background turn on that process (with `preemptions < 3`) yields at its next step boundary. It calls `schedule_run(run, now())`, the turn becomes `parked`, and its pointer stays. Workers drain people and delegated queues first, so the parked turn resumes when capacity frees, without spending an attempt, and continues from items. A step that runs longer than 30 s is aborted and repeated on resume.

**Decision: a person writing into a conversation that is running a cron turn parks the cron turn.** The person's input is queued at people tier, and the cron turn is asked to yield the conversation. At its next step boundary it runs one transaction:

1. Mark itself `parked`.
2. Point `active_turn_id` at the person's turn and spawn it.
3. Suspend on `await_event('resume:<cron_turn>')`.

The person's turn end prefers parked turns: it moves the pointer back and emits `resume:<cron_turn>` into the background queue. The transcript shows the cron turn's earlier work, then the person's turn, then the cron turn continuing.

**Fairness across swarms** (_default, changeable later_: at most 8 active background turns per swarm, else per cron or loop owner): Absurd queues are FIFO, so one swarm that admits 500 child turns would make all other background work wait behind it. Admission over the cap inserts the turn as `queued` on the owner's backlog. Turn end already starts queued input, and it also starts the owner's next backlog item. One mechanism handles both, with no new queues and no polling.

### 4. Fan-out and fan-in

- **Fan-out**: spawning N subagents is one transaction (N `turns` rows, N pointers, N `spawn_task` calls).
- **Batching (default)**: a finished child's turn end queues a child-result row on the parent session, or spawns a parent turn if the parent is idle. The parent's next turn takes **all** queued child results at once as `Wake` items (`wake_cause='child_done'`). Forty children finishing while the parent is busy become one parent turn. This replaces `pendingReturns`, `markReturned`, `deferReturn`, and the session-return sweep.
- **Barrier wait (`subagents wait all`)**: the parent writes `turn_barriers(turn_id, remaining = N, queue)` and suspends on `await_event('barrier:<turn>', timeout)`. Each child's turn end decrements `remaining`. The child that brings it to 0 emits `barrier:<turn>` into the parent's queue. The parent is woken once, and holds no worker while it waits, even for days.
- **Tree cancel**: `cancelTree(session)` walks `sessions.parent_session_id` with a recursive CTE in one transaction. For each descendant it runs `cancel_task` on the active turn's task, marks queued rows `stopped`, clears pointers, and sends `pg_notify('qm_turn_cancel', turn)`. The owning process aborts at once instead of waiting for `AB001`.

### 5. Suspension, timers, and multi-day work

- **Inside a turn** (waiting minutes for CI, a barrier, or later an approval): the turn sets `status='waiting'` and suspends on one event name per suspension, `wake:<turn>:<k>`, with an optional timeout. Every wake cause emits that same name: steer, cancel, child result, approval, or client tool result. The pointer stays held.
- **Across turns** (check back tomorrow): the turn **ends** and schedules a wake task in the background queue. That task sleeps until the time, then runs admission with a `Wake` input (`wake_cause='system'`). People can use the conversation meanwhile.
- **Approvals and client tools** move to `wake:<turn>:<k>` suspension in a later PR, which frees the worker while a person decides.

### 6. The harness as its own ECS service

- **Roles.** `QM_ROLES` defaults to `api,surfaces,harness`, so a self-hosted install is still one process.
- **core** (`api,surfaces`): HTTP API, web streaming, Slack ingress, and admission transactions. It never runs a turn.
- **harness** (`harness`, grown from `src/runs/worker-main.ts`): the claim loop, turn tasks, cron scheduler, maintenance sweepers, pointer repair, and Absurd cleanup.
- **Deployment.** One harness service per deployment, deployed with rolling updates (minimum healthy 100%, maximum 200%, so the incoming task is up before the outgoing one gets SIGTERM).

**Already cross-process today (verified):**

- Run stream deltas go over Postgres NOTIFY; `run-stream-events.ts` chunks them to fit the payload limit.
- Session-state events go through `postgres-session-state-bus.ts`.
- Slack and web delivery are outbound from whichever process runs the turn.

**Deploys after the split:**

- **API or Slack deploy**: nothing is interrupted.
- **Harness deploy**: the SIGTERM handback in section 2. The user sees a pause of a few seconds while the incoming instance picks the turn up, and at worst one repeated model call.
- **Version skew**: task params are `{turnId}`, unknown task names are deferred rather than failed, and schema changes stay expand/contract.

**Deleted:**

- the background-ownership record and protocol, and its controller;
- `/v1/background-work` and the CLI ownership guards, including #2472;
- the drain controller and instance registry.

The cron scheduler already uses its own leader lease and slot claims, and the other sweepers use advisory locks. **Core moves to rolling deploys** once it runs no turns (_default, changeable later_).

### 7. Cutover

- **Install**: a startup migration installs the vendored Absurd 0.5.1 SQL, creates the three queues, and sets retention to 7 days (_default, changeable later_).
- **Routing**: a feature flag `absurd_turns` per scope. Admission uses Absurd when the flag is on **and** the session has no pending or running legacy run. Otherwise it writes a legacy row, so each conversation drains its legacy work in order.
- **Legacy claim**: adds `AND candidate.engine='legacy'`. Its sibling check already treats Absurd turns in the same session as running siblings.
- **No data migration**: in-flight runs finish on the old engine, and new turns start on Absurd.
- **Ramp**: Regan's personal scope first, then the background tier org-wide, then everyone.
- **Deletion**: once no legacy runs are pending or running for a day, delete the legacy engine and the in-memory run store, and rename `runs` to `turns`.

### 8. Decisions and defaults

Decided (2026-10-20):

1. **Takeover** uses timed leases plus fencing, with no ECS-only proof of death. On SIGTERM, turns are handed back immediately with no retry spent and are resumed from items by the incoming instance. A deploy never waits on a turn, and SIGKILL is safe because of fencing.
2. **Absurd owns** queues, leases, retries, timers, events, and cancellation. `items` is the only step record. Absurd checkpoints only at suspensions.
3. **A person writing into a conversation that is running a cron turn parks the cron turn.**
4. **Delete the in-memory run store.** Run-engine tests run on Postgres.

Defaults, changeable later:

- a thin TypeScript client (about 300 lines) instead of `absurd-sdk`, because turn start and turn end must call Absurd inside QM transactions;
- Absurd pinned at 0.5.1 and vendored, with local patches if needed;
- background cap of 8 per swarm, else per owner;
- 7-day Absurd retention;
- queued input in a busy conversation ordered people-first, then FIFO;
- rename `runs` to `turns`;
- rolling deploys for core once it runs no turns;
- a 60 s lease extended every 20 s.

## Code: what goes, what comes

Estimates from `wc -l` on main at `69b2cfb0`; production code only.

**Deleted (about 2,600–3,000 lines):**

| Code                                                                                                                     | Lines       |
| ------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `postgres-run-store.ts`: claim, sibling check, leases, heartbeat, reaper, retry, availability, preemption                | ~350 of 679 |
| `worker.ts`                                                                                                              | 330         |
| `memory-run-store.ts`                                                                                                    | 422         |
| `run-signal-store.ts`, `postgres-run-signal-store.ts`                                                                    | 393         |
| `background-ownership.ts`, `background-controller.ts`, `drain.ts`, `instance-registry.ts`, `reaper.ts`, `retry-delay.ts` | 377         |
| `turn-resume.ts` backward scan                                                                                           | ~100 of 178 |
| `api/routes/background-work.ts`, `cli/src/background-work.ts`, AWS ownership guards                                      | ~550        |
| `wiring.ts` preemption, return sweep, signal pruning, reaper and ownership wiring                                        | ~250        |

**New (about 1,200 lines plus vendored SQL):**

| Code                                                                                          | Lines (est.)         |
| --------------------------------------------------------------------------------------------- | -------------------- |
| `src/turns/absurd.sql` (0.5.1, vendored) and its migration                                    | 3,158 vendored + ~60 |
| `src/turns/absurd.ts`: thin client                                                            | ~300                 |
| `src/turns/admission.ts`: admission and turn end, queued input, batching, owner cap           | ~250                 |
| `src/turns/harness-loop.ts`: multi-queue claim, LISTEN, slots, extend, park, SIGTERM handback | ~250                 |
| `src/turns/turn-task.ts`: orchestrator per turn, suspensions, fencing, error budget           | ~200                 |
| `src/turns/repair.ts`, `cancel-tree.ts`, `barriers.ts`                                        | ~150                 |
| `src/harness-main.ts`, roles                                                                  | ~60                  |

Net: about 1,400–1,800 fewer production lines.

## Risks

1. **Absurd maturity.** Absurd is at 0.5.x and describes itself as "an experiment in durability." Mitigations: the SQL is pinned and vendored, QM uses about ten functions, and the plpgsql is readable and patchable. Today's 0.5.1 fixed a real scaling problem, so upstream is active, but rough edges remain.
2. **Polling.** One loop per process, three queues, LISTEN, and a 1 s fallback poll come to about 12 claims/s for four idle harness tasks. Keep watching `t_` size; retention bounds it.
3. **Table growth.** About 50k turns a day at 7-day retention is roughly 350k task rows. Partitioned storage is the next step if needed.
4. **Fairness.** The cap needs a dashboard number for each swarm.
5. **Crash attempts.** Hard kills before handback spend attempts, and a crash loop could exhaust 10. Planned shutdowns spend none.
6. **Version skew** during rolling harness deploys.
7. **Two engines at once** during cutover. Covered by tests (section 7).
8. **Event scope.** Emitting into the wrong queue wakes nothing. Barrier and resume rows record the target queue, and a test covers cross-queue fan-in.

## Staged PR plan (estimates; Pacific)

| PR        | Contents                                                                                                                                                                                                                                  | Estimate             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1         | Vendor Absurd 0.5.1, startup migration, three queues, thin client, Postgres tests. No behaviour change. Brief below.                                                                                                                      | 1 day, Wed Oct 21    |
| 2         | Turn ledger columns, `sessions.active_turn_id`, admission and turn-end transactions, turn task on Absurd (one queue), steer as item, stop as `cancel_task`, fencing, SIGTERM handback, pointer repair. In-process, behind `absurd_turns`. | 3 days, Mon Oct 26   |
| 3         | Three queues, preferring claim loop with LISTEN, overcommit and capacity parking, cron-turn parking                                                                                                                                       | 2 days, Wed Oct 28   |
| 4         | Fan-in batching, barrier wait, tree cancel, scheduled wakes, per-swarm cap                                                                                                                                                                | 3 days, Mon Nov 2    |
| 5         | `QM_ROLES`, `harness-main`; crons and sweepers to harness; qm-yc harness ECS service (rolling); dogfood rehearsal including a deploy during a long turn                                                                                   | 2–3 days, Thu Nov 5  |
| 6         | Ramp to all; wait for the legacy drain; delete the legacy engine, in-memory run store, signals, ownership protocol and CLI guards; move incidental test users to Postgres; rename `runs` to `turns`; core to rolling deploys              | 2–3 days, Tue Nov 10 |
| 7 (later) | Approvals and client tools as suspend-for-event; Rust port of the client for crystal                                                                                                                                                      | —                    |

Faster options: merge PRs 1 and 2. In PR 3, start with reserved people slots and add overcommit only if people still wait. Delete the ownership protocol in PR 5.

### PR 1 brief: install Absurd and a thin client (no behaviour change)

**Goal**: every QM Postgres database gets the `absurd` schema (0.5.1) and the queues `turns_people`, `turns_delegated`, and `turns_background` at startup, through the existing migration ledger. There is also a tested thin client. Nothing calls the client in production yet.

**Add:**

- `src/turns/absurd.sql`: upstream `sql/absurd.sql` at tag `0.5.1`, unmodified. Record the upstream commit SHA in the PR description; nothing goes in the file, because code comments are not allowed.
- `src/turns/absurd-schema.ts`, about 60 lines:
  - It reads `absurd.sql` and splits it into top-level statements. The splitter respects `$$`/`$tag$` bodies, quoted strings, and `--` comments. QM's migration runner requires exactly one statement per entry (`assertOneStatement` in `src/persistence/pg-pool.ts`).
  - It registers one migration, `absurd/0.5.1`, using `definePgMigration` with an expected checksum.
  - It then runs `SELECT absurd.create_queue(q, 'unpartitioned')` for each queue, and `SELECT absurd.set_queue_policy(q, '{"cleanup_ttl":"7 days"}')`.
  - Registration happens alongside the other schemas so `migrateRegisteredPgSchemas` applies it at startup. The migration ledger makes re-runs no-ops, and the vendored file's `create function` without `or replace` never runs twice.
- `src/turns/absurd.ts`, about 300 lines: a transaction-aware client. Every function takes a `pg` `PoolClient` or `Pool` so callers can compose it inside their own transaction. It covers:
  - `spawnTask(db, queue, name, params, {idempotencyKey, maxAttempts, retryStrategy})`
  - `claimTasks(db, queue, workerToken, claimTimeoutSec, qty)`
  - `extendClaim`, `scheduleRun(db, queue, runId, wakeAt)`, `completeRun`, `failRun(db, queue, runId, reason, retryAt?)`
  - `awaitEvent(db, queue, taskId, runId, step, event, timeoutSec?)` returning `{suspended, payload}`
  - `emitEvent`, `cancelTask`, `getCheckpoint`, `cleanup(db, queue, ttlSec, limit)`
  - `holdsClaim(db, queue, runId, token)`, the fence check: `SELECT … FOR SHARE` on `state='running' AND claimed_by=$token`
  - Error mapping: `AB001` becomes `TaskCancelled`, `AB002` becomes `RunFailed`.
- `test/postgres-absurd.test.ts`, added to the `test:pg` list in `package.json`:
  - the migration applies on an empty database and again as a no-op, and the schema version is 0.5.1;
  - the three queues exist with a 7-day TTL;
  - spawn, claim, complete round-trips;
  - `scheduleRun(now)` makes the run claimable again with the same attempt number and clears `claimed_by`;
  - `holdsClaim` is false after handback and after lease expiry plus a sweeping claim;
  - lease expiry produces attempt 2;
  - `awaitEvent` suspends, `emitEvent` from another connection wakes it, and the payload is returned;
  - an emit to a different queue does not wake it;
  - `cancelTask` makes the next `extendClaim` raise `TaskCancelled`;
  - `spawnTask` inside a rolled-back transaction leaves no task.
  - Use `absurd.fake_now` for time control.
- `test/absurd-sql-split.test.ts`: the splitter produces statements that all pass `assertOneStatement`, and their concatenation equals the file with whitespace normalized.

**Delete**: nothing in PR 1.

**Constraints**:

- zero code comments and no AI trailers;
- git author Regan Bell, committer Quartermaster;
- do not edit `docs/SPEC.md`;
- the PR description lists the vendored SQL as vendored and gives its upstream SHA, and reports the diff size with the vendored SQL separated from hand-written code (hand-written estimate +450 / −0).

**Checks**: `tsc --noEmit`, eslint and oxlint, `npm run test:pg` locally against native PostgreSQL 16, and CI `core-postgres`.

**Dev-instance QA** (QA on real sandboxes):

1. Install PostgreSQL 16 natively (`sudo apt-get install -y postgresql`), create a database, and set `DATABASE_URL` in the worktree `.env` so the dev script skips Docker Postgres.
2. Start a dev instance with a real cloud sandbox backend (`--sandbox sprites`, or `e2b`).
3. Confirm that startup applies `absurd/0.5.1` (`SELECT * FROM qm_schema_migrations WHERE id LIKE 'absurd/%'`), that `absurd.list_queues()` returns the three queues, and that a restart applies nothing new.
4. Run one ordinary web turn that uses the sandbox, and confirm it completes on the legacy engine, unchanged.
5. Run the thin-client round-trip test against that database.
6. Clean up any sandboxes created during QA.
