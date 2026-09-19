# Durable workflows

QM uses Absurd 0.5.0 inside its existing PostgreSQL database. The schema is vendored, checksummed, and installed by the normal migration runner. Workers run in the QM process; no additional service is required. Production requires PostgreSQL. The memory adapter is for tests and disposable local instances.

The vendored Absurd SQL retains its third-party license in `src/durable/vendor/ABSURD-LICENSE`. The adjacent JSON records the pinned upstream source and the modifications made when importing it. Seed skills remain subject to the existing MIT-only check; the license check explicitly recognizes this Absurd component.

## Ownership

Absurd owns attempts, leases, retry timing, checkpoints, sleeps, and event waits. QM retains runs, session history and tape, deliveries, cron history, loops, approvals, credentials, and other product records. Those records remain the authorization and user-facing state.

| Queue           | Work                                                                                   |
| --------------- | -------------------------------------------------------------------------------------- |
| `qm_runs`       | Run execution, per-session ordering, worker replacement                                |
| `qm_handoffs`   | Final-result delivery admission, child returns, orphaned signals, swarm reconciliation |
| `qm_deliveries` | Slack messages, files, approvals, and web transcript delivery                          |
| `qm_ingress`    | Accepted Slack event and interaction envelopes                                         |
| `qm_triggers`   | Cron occurrences, webhook work, process monitors, credential continuations             |
| `qm_loops`      | Loop fires, shipping, follow-up, item actions, and returns                             |
| `qm_memory`     | Delayed, batched automatic memory capture                                              |

Run and delivery admission commit their Absurd task in the same transaction as the domain row. Terminal run updates, pending signals, and swarm transitions create their continuations transactionally. Other workflows use durable domain receipts and deterministic admission keys so interrupted admission can be reconstructed.

The run tape remains the model's recovery record. Workflow checkpoints do not serialize a JavaScript stack. A replacement worker reconstructs the turn from committed history, goals, inbound file paths, and staged attachments. Session writes are fenced by the specific run attempt's lease. An expired worker cannot keep writing or release its successor's session lease.

## Effects and retries

Each workflow separates durable admission, execution, and delivery. Named checkpoints reuse completed work. Database mutations that can commit before their checkpoint have stable operation receipts. Current authorization is checked again when work resumes; a recorded grant is not a permanent permission.

External APIs cannot generally promise exactly-once effects. Slack delivery uses stable message metadata and staged file IDs to discover accepted effects before retrying. Source sends that cannot safely reconcile an uncertain response stop for operator reconciliation rather than blindly sending again. Progress messages are disposable; a per-run lock and terminal-state check prevent late progress from replacing a final answer.

A browser is not required to complete web delivery. The delivery worker writes the durable transcript, and reconnecting clients refresh it. Slack receivers persist the incoming envelope before acknowledging it. Missing adapters defer their work without exhausting a failure budget.

Native retry policies use exponential backoff. Accepted follow-on obligations use unbounded retry where abandoning them would lose work. Run retry and age limits remain bounded product policy. Failed and waiting tasks, their attempts, checkpoints, and error history remain in the `absurd` schema for inspection. Do not delete that history while a replay or idempotency key may still be needed.

## Routine deployment handoff

A deploy stops new claims and asks admitted runs and workflows to yield. Turns finish their current committed step, then the incoming worker resumes from tape. Pi continues a clean native conversation without adding an interruption message. A parent waiting on another durable run or workflow yields its wait; a long child, Loop stage, or cron fire does not keep the old core alive until the whole operation finishes.

`BACKGROUND_HANDOFF_GRACE_MS` defaults to 120 seconds and cannot exceed 120 seconds. At the deadline, the old run attempt is cancelled and fenced. An unfinished model call may be repeated; partial streamed text stays in a tape annotation. An uncommitted tool outcome uses the existing uncertain-outcome recovery path. Deploy handoffs do not consume the run's failure or claim budget.

Surrender replaces the native execution token atomically while retaining the logical attempt, task identity, checkpoints, and lifetime. The incoming worker can claim immediately after surrender, without an extra lease-expiry wait. Late checkpoints, heartbeats, completion, and session writes from the former owner are rejected. Crash recovery still waits for lease expiry when no owner acknowledged a handoff.

Worker generations also have durable claim fences in `qm_durable_workers`. Retirement serializes with claims and surrenders committed claims even when their acknowledgements never reached the worker. A restart uses a new generation; fence rows remain to reject delayed queries from retired generations.

Generic workflows yield at the boundary of the outermost admitted step. Nested checkpoints persist intent and intermediate results without splitting an intent from its dispatch during cooperative handoff. The hard deadline applies at every nesting level. Database requests and provider calls inherit cancellation; late responses cannot restart the old execution.

Uncertain external effects remain durable obligations after the worker yields. A Slack post with a dispatch receipt and no acknowledgement is reconciled by message metadata, never blindly resent. It can remain pending when acceptance cannot be established. Memory providers without idempotency support likewise require reconciliation after an ambiguous write. This preserves cutover without treating a timeout as proof that the external effect failed.

Cancellation cleanup has its own finite deadline and cannot reopen normal execution. Remote process termination targets the original body, awaits the termination request, and leaves a cancellation marker so a delayed command cannot start after cleanup. Sandbox restoration publishes readiness only after hydration succeeds; an unfinished body cannot be adopted while old cleanup might still terminate it. Known multipart upload IDs are compensated even when cancellation wins as their creation response arrives.

Maintenance batches stop between items and cancel their active transport or subprocess before joining it. Both controlled background ownership and legacy build supersession request the same handoff, and rollback starts a fresh admission generation. Process termination uses the shorter shutdown budget and a final exit backstop. A database outage can prevent acknowledged surrender; native lease expiry remains the fallback for that failure, as for a process crash.

## First transition from the previous runtime

The one-time conversion from the legacy queue protocol is separate from routine deploy handoff. Its adoption migration must run after old producers and workers have relinquished ownership. Running an adoption migration while legacy binaries still admit or execute work is unsafe.

1. Deploy a legacy-compatible release with committed-step handoff first if the current binary does not support it. A new binary cannot add cooperative handoff to an already-running old process.
2. Back up PostgreSQL and record the deployed revision. Verify sandbox images support `setsid --wait true`; QM's image recipes install and check `util-linux`, while existing custom images need the same dependency.
3. Pause the old cohort's admission through the background ownership protocol and wait for it to acknowledge relinquishment and drain through handoff. Close old Slack ingress and synchronous execution too. No old binary may insert runs after migration begins.
4. Run the Absurd migration, then admit the new deployment. Existing queued and running runs are adopted into native tasks; old turn leases are invalidated. Pending delivery, signal, child-return, monitor, and swarm obligations are recovered from their domain records.
5. Verify a real turn, final delivery, cron, and monitor work before restoring normal admission.

Legacy and Absurd workers cannot share active ownership. Returning to a legacy binary requires a coordinated database restore or a separately reviewed reverse migration; changing the deployed image alone is not a rollback. Preserve the `absurd` schema and task history across normal updates. Existing legacy queue tables can remain during the cutover; the new runtime does not consume them.

## Validation

The durable runtime tests exercise transactional rollback, deduplicated admission, cross-worker checkpoints and events, startup recovery, claim races, lease expiry, and bounded shutdown. Run tests cover FIFO, stale-owner fencing, retries, cancellation, and migration adoption. Workflow tests inject failures between domain writes and checkpoints and verify later authorization changes. Delivery tests cover uncertain Slack posts and uploads, approval cards, missing adapters, account routing, and browser-independent transcript writes.

Use `npm run test:pg` with a disposable PostgreSQL database and a role allowed to create test databases. The new workflow tests isolate schemas in separate databases because Absurd queue tables live in the shared `absurd` schema. Use the dev-instance skill for real-model Slack and web verification.
