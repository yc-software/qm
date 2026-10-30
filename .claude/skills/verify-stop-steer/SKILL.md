---
name: verify-stop-steer
description: Model-check the web UI's Stop / steer / queue protocol (plugins/web-ui composer and chat, core run signals, the run queue and the harness signal poll) with TLA+. Use before and after any change to how the web composer queues or steers a message, how Stop is sent or acknowledged, how /v1/runs/:id/signal, stopSessionTree, steerQueued or replayOrphanedRunSignals behave, or how a harness drains run signals.
---

# verify-stop-steer

`StopSteer.tla` is a small model of one web chat thread: the browser (composer, transcript, Queued chips, waiting steer rows, the Stop button), the core API (`/api/turn`, `/api/runs/:id/signal`, `/api/runs/active`), the run queue, and a harness turn that drains run signals. TLC explores every interleaving of those steps for one message (two with `MSGS='{1, 2}'`) and checks the promises below.

## The promises (invariants)

| Invariant             | Promise to the person                                                                                                 | Harm when broken                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `StopFreezesReply`    | Once Stop is acknowledged, the reply being stopped stops growing.                                                     | Text keeps streaming after Stop; Stop feels ignored.           |
| `NoTurnAfterStop`     | Once Stop is acknowledged, no other turn renders output unless the person sent its message after pressing Stop.       | QM answers after Stop.                                         |
| `StopNotIgnored`      | A Stop that reaches the server while any turn of the thread is live stops that work.                                  | Stop does nothing; the next turn runs on.                      |
| `NoSilentLoss`        | Every message that left the composer is delivered, still pending somewhere, or back in the composer.                  | A typed message vanishes.                                      |
| `DeliveredOnce`       | No message reaches the model twice.                                                                                   | Duplicate work and duplicate replies.                          |
| `ShownOnce`           | A message never shows twice at once (transcript row, Queued chip, waiting steer row).                                 | Doubled messages and flicker.                                  |
| `SentIsShown`         | From the moment a message leaves the composer it is visible somewhere until it lands.                                 | A sent steer seems not to go out; messages blink out and back. |
| `ControlsMatchServer` | When every request has settled, the UI's streaming state, followed run and Queued chips match the server's run queue. | Stale Queued chips, a missing Stop button while a turn runs.   |

## Run it

```bash
.claude/skills/verify-stop-steer/run.sh
```

Needs Java 11+ and curl. The script downloads tla2tools v1.7.4 once (checksum pinned) into `~/.cache/qm-tla`, runs about 18 TLC checks in roughly 90 seconds, and prints one line per check. Modes:

- `run.sh current` checks the model of the code as it is (`Fixes = {}`). Several invariants fail today; those are the findings below, recorded as `fail` in the `CURRENT` table in `run.sh`.
- `run.sh fixed` turns on every proposed fix flag (`FIXES` in `run.sh`). Everything passes except `SentIsShown`.
- `run.sh breaks` adds a deliberate break to the fixed model and expects the guarded invariant to fail, proving the check can fail.
- `run.sh one <Invariant> [current|fixed] [break]` runs one check with the shortest counterexample and prints the log path.
- `FIX_ONLY='"serial_controls"' run.sh one <Invariant>` runs with just the listed fix flags, which peels one finding off to show the next one.
- `MSGS='{1, 2}' run.sh one <Invariant>` uses two messages. It is far larger: a current-code `DeliveredOnce` run passed 37 million distinct states without a violation before its on-disk state queue filled the machine. Use it only on a machine with room to spare, never on every edit.

`ok` means the result matched the recorded expectation. `CHANGED` means it did not, and the script exits 1. Logs and traces land in `$TMPDIR/verify-stop-steer/` (override with `VERIFY_OUT`).

Read every result with the pstack `/statechart` skill: it turns a TLC violation into its shortest path in plain words, and charts the state machine when a check passes.

## Does my change touch this?

Coverage record, last confirmed against commit `393cd746e9dfa7c3ee363aa407343b504978f484` (sync commit):

```bash
git diff --stat 393cd746e9dfa7c3ee363aa407343b504978f484 -- \
  plugins/web-ui/src/composer.ts plugins/web-ui/src/chat.ts plugins/web-ui/src/core-bridge.ts \
  plugins/web-ui/src/conversations.ts plugins/web-ui/server/index.ts \
  src/api/app-turn.ts src/api/app-helpers.ts src/api/routes/turns.ts src/sessions/session-syscalls.ts \
  src/runs/run-signal-store.ts src/runs/postgres-run-signal-store.ts src/runs/postgres-run-store.ts \
  src/harness/pi-harness.ts src/harness/claude-harness.ts src/harness/harness-shared.ts src/wiring.ts
```

The command compares the working tree with the sync commit, so it also sees uncommitted edits. If that diff touches a function in the table below, re-read the function, decide whether the matching model action still says what the code does, and run the check. Move the sync commit forward (here and in this paragraph's command) only after you have confirmed the model describes the code at the new commit.

| Model action                                  | Code                                                                                                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SubmitWhileStreaming`                        | `composer.ts` `sendPromptNow` → `queueDraft` (draft cleared, `uploadAttachments`, then `enqueueTurn` → `queueTurn`); `pref` is `alwaysSteer()` vs Queue/Tab       |
| `SubmitIdle`, `ServerSend`, `ClientSendReply` | `composer.ts` `sendPromptNow` → `agent.prompt`; `core-bridge.ts` `drive`, `followRun` (sends a Stop clicked before the runId existed)                             |
| `ServerTurn`                                  | `app-turn.ts` `turn` (web turns skip server-side steer routing and enqueue a pending run)                                                                         |
| `ClientTurnReply`, `SteerStart`               | `composer.ts` `enqueueTurn`, `steerQueued` (request half), `markSteering`, `addQueuedRun`                                                                         |
| `ClickChipSteer`, `VisibleChips`              | `composer.ts` `queuedStrip` (chips hidden while their steer is pending)                                                                                           |
| `CanSteer`                                    | `composer.ts` `canSteer`                                                                                                                                          |
| `ServerSteerCheck`                            | `app-turn.ts` `signalRun` reads before `steerQueued` (terminal, `not_found`, `queued_started`)                                                                    |
| `ServerSteerCte`                              | `postgres-run-store.ts` `steerQueued` (one statement: delete the queued run, insert the steer signal)                                                             |
| `ServerSteerAfter`, `DrainEffect`             | `app-turn.ts` `signalRun` after `steerQueued`; `app-helpers.ts` `replayOrphanedRunSignals`                                                                        |
| `ClientSteerReply`                            | `composer.ts` `steerQueued` outcome handling, then `chat.ts` `resumeIfIdle`                                                                                       |
| `ClickStop`                                   | `composer.ts` `stopStreaming` → `chat.ts` `stopLiveRun`; `core-bridge.ts` `requestStop`, `signalLiveRun`                                                          |
| `ServerAbort`                                 | `app-turn.ts` `signalRun` (abort) → `stopRunTree` → `session-syscalls.ts` `stopSessionTree`                                                                       |
| `ClientAbortReply`                            | `chat.ts` `stopLiveRun` after `signalLiveRun` resolves (a 409 is returned, not thrown)                                                                            |
| `Dispatch`                                    | run queue: one running run per session, oldest pending first (`postgres-run-store.ts` `inFlightForThread` order); the turn's user entry is recorded at start      |
| `HEmit`, `HFinish`, `HStopped`                | `pi-harness.ts` / `claude-harness.ts` turn loop; `harness-shared.ts` `recordStoppedTurn`                                                                          |
| `HDrain`                                      | `run-signal-store.ts` `startSignalPoll` drain; harness `onSteer` (queue, leave unacknowledged) and `onAbort` (`userAborted`, `clearQueue`)                        |
| `HIntake`                                     | `pi-harness.ts` `onMessageEnd` → `harness-shared.ts` `recordSteerIntake` (steered user entry, then acknowledge)                                                   |
| `OrphanDrain`                                 | `wiring.ts` `runs.onTerminal` → `replayOrphanedRunSignals`, and the pending-signal sweeper                                                                        |
| `Observe`                                     | `core-bridge.ts` `streamRunViaSse` / `pollRun` → `applyRun`, `abortStream`; `chat.ts` `observeLiveWork` → `appendConsumedSteers`; `composer.ts` `steeringRunsFor` |
| `Refresh`                                     | `chat.ts` agent_end → `refreshTranscriptFromEntries` → `replaceTranscriptFromEntries` (skipped after an aborted reply)                                            |
| `StartFollowNext`                             | `chat.ts` `followNextQueuedRun`                                                                                                                                   |
| `NotifiedWorking`, `ResumeIfIdle`             | `conversations.ts` session-state `working` event → `resumeIfIdle` → `resumeTrackedRun`                                                                            |
| `ServerActive`                                | `app-turn.ts` `activeRunForThread`; `plugins/web-ui/server/index.ts` `GET /api/runs/active`                                                                       |
| `ClientActiveReply`                           | `chat.ts` `followNextQueuedRun`, `resumeTrackedRun` → `resumeRun`; `core-bridge.ts` `continuableMessages`                                                         |

Each server request is split where the code awaits between reads and the write that matters (`ServerSteerCheck` / `ServerSteerCte` / `ServerSteerAfter`). `steerQueued` and `stopSessionTree` (under the session-tree advisory lock) are single steps. A browser handler runs atomically between awaits. The session-state `working` event fires when a run is enqueued (`Created`, `DrainEffect`), and the `idle` event after the thread's last live run ends drives `IdleRefresh` (`conversations.ts` → `chat.ts` `onDelivery`).

## Real bug or modeling error?

Walk the counterexample step by step against the table. It is a real bug if every step is something the code can do in that order: an HTTP request can be overtaken by another, SSE and polling deliver late, the harness drains signals on notify or every 5 s. It is a modeling error if a step needs something the code forbids (an await that is not there, a guard the model lacks, a button that is hidden). Fix modeling errors in `StopSteer.tla`; never weaken an invariant to make a run pass.

## Changing the protocol on purpose

1. Edit the action that models the changed code, keeping names from the code.
2. If a fix flag in `FIXES` now describes shipped behavior, make it the default in the action, delete the flag, and drop it from `FIXES`.
3. Run `run.sh`. Update the `CURRENT` / `FIXED` tables in `run.sh` only for results you have explained.
4. Add a break to `BREAKS` for any new invariant so it is seen failing.
5. Move the sync commit after confirming the model matches the code.

## Stop and queued messages

Today Stop deletes the thread's queued messages (`stopSessionTree` withdraws every pending run) but replays steers the model had not yet taken in (`replayOrphanedRunSignals`). `NoSilentLoss` and `NoTurnAfterStop` together state the intended rule: after Stop nothing sent before it runs, and nothing sent before it disappears, so undelivered text goes back to the composer. If the product decides Stop should instead keep queued messages queued, change those two invariants deliberately and record why.

## Fix flags (proposals, not shipped code)

`freeze_on_stop` (stop rendering a run once Stop is clicked or acknowledged for it), `serial_controls` (send queue, steer and stop requests one at a time in click order; a server-side alternative is taking the session-tree lock in web `turn()`), `stop_returns_inputs` (Stop takes withdrawn queued messages and unconsumed steers off the server and returns their text in the abort response for the composer; this changes the API and needs `recordSteerIntake` to acknowledge before it records, so a taken steer cannot also reach the model), `stop_terminal_target` (Stop on a run that just ended still stops the thread), `drop_replay_push` (do not push a local row on a `replayed` steer reply), `optimistic_submit` (show the message as sending while `queueTurn` is in flight), `steer_rows_until_landed` (keep a waiting steer row until the message lands in the transcript), `chip_skips_started` (hide a Queued chip once its run's prompt row is shown), `no_self_steer` (never steer a queued run into itself), `turn_reply_resyncs` (an idle chat re-reads the run queue after a queue reply), `fresh_queue_sync` (ignore a run-queue snapshot taken before a newer local change), `sync_includes_transcript` (the run-queue sync also brings in landed prompt rows).

Break flags: `skip_ack` (`recordSteerIntake` stops acknowledging; guards `DeliveredOnce`), `stop_only_target` (Stop aborts only the clicked run; guards `NoTurnAfterStop`).

## Scope

Verified: every interleaving of the listed steps for one message (and, slower, two), one Stop per behavior, one chunk of assistant text per run, one initial running turn. Assumed: one browser tab, no network errors or retries, no process crashes, no lease expiry or reaping, no approvals, no attachments, no subagent trees beyond the thread itself, the pi and Claude harnesses behave the same at this level. Not covered: liveness (no fairness; "Stop eventually stops" and "a queued message eventually runs" are unchecked), Slack, inbox threads, `editQueuedRun`, `withdrawRun` from the chip's Remove button, approval pauses, timing (how long any step takes), out-of-order replies between concurrent `/api/runs/active` calls (the model keeps one in flight), the two separate core reads behind the web server's `GET /api/runs/active`, a transcript page fetched before the moment it is applied, the `hasDedupeKey` short-circuit for retried steers, swallowed `steer acknowledge` failures, and Stop waiting on the session-tree lock behind subagent operations.
