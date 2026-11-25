# Delegation: subagents, peer sessions and swarms

_Verified against `main` at eb148f69d (2026-11-24). Statements were read in the code at that commit unless marked **[interpretation]**._

## In one paragraph

Delegation is how one agent turn gets other turns to do work for it. It has three forms. A turn can open a **subagent**: a new session with its own transcript, kept out of the sidebar, that works on a written task and reports to the session that opened it, its **parent**. A turn can message another ordinary conversation in the same scope, a **peer**. Or a turn can start a **swarm**: a pool of worker sessions, each on its own blank computer, that talk through one shared message list. All three are built from the same two things: queued runs (see [turns](./turns.md)) and durable mail in Postgres. No delegation state lives in process memory. Mail reaches a busy recipient when its next tool call returns. An idle recipient is **woken**: a new run is queued in its conversation. A finished child's result is mail too, and the child's run is not marked returned until the parent has read that mail or a wake for it has run. Stopping has a scope: the Stop button stops one conversation and leaves its subagents working; a typed `stop` stops the whole tree.

## One delegation, traced end to end

The example: Ada at Acme asks the agent in the web app to "reconcile the March and April billing exports against the ledger". The agent opens two subagents, "March" and "April". March finishes first. Ada presses Stop on her conversation while April is still working.

1. **The tool call.** The model calls the `subagents` tool with `action: "open"` and a `task`. `sessionTools` in `src/agent/agent-tools/sessions.ts` defines the tool. It holds no logic: it calls `open` on the turn's `SessionSyscalls`, an object that `createSessionSyscalls(...).forTurn(binding)` in `src/sessions/session-syscalls.ts` builds once per turn from that turn's own request.
   - _Who gets the tool:_ every turn except one whose conversation has an external audience. `handleTurn` in `src/core/orchestrator.ts` passes no syscalls there.
2. **Admission.** `open` takes the Postgres advisory lock `session-tree-admission`, then re-checks the caller: its own run has not been stopped (`runStopped`), its session still exists in the same scope, and its actor may still act in that scope. It refuses a swarm worker, a side chat that has not been opened as a session, and an empty task.
3. **The child session.** The child's thread ref is `agent:main:subagent:` plus a hash of the parent session, the parent run and the request id. The request id defaults to the tool call id, so a retried tool call finds the same child instead of making a second one. The same id with a different task is refused. `open` creates the session in the parent's scope, sets `parent_session_id`, adds the actor and the conversation's audience as participants, and saves `spawn_meta`: the context every later run of this child starts from (actor, conversation, audience, surface, delivery target, read-only flags, model). `sessionContextOf` builds it from the parent's request. `openRuntime` in `src/sessions/subagent-runtime.ts` picks the model. `childIsolation` in `src/sessions/child-isolation.ts` picks where commands run.
4. **The first run.** `open` queues a run in the child's thread with dedup key `subagent-open:<threadRef>`. Its text is the task inside a `<subagent-task>` envelope. Its request carries `sessionSenderId` (the parent session) and `delegatingRunId` (the parent's run). The tool returns at once with the child's session id. `runPriority` in `src/runs/run-store.ts` gives a delegated run priority 1: behind people's turns (0), ahead of background work (2).
5. **The child's turn.** It runs as any turn does ([turns](./turns.md)), with three differences. `isSessionTurn` in `src/core/turn-origin.ts` is true, so the orchestrator does not trust the origin copied into the request; it calls `delegatedAuthorization`, which walks the `delegatingRunId` chain back to a turn that a person or an owner's trigger started and checks every link. `src/core/orchestrator/sandboxes.ts` calls `ensureChildSandbox` and `prepareChildWorkdir` to prepare the child's placement. The prompt gains the text from `isolationBrief`.
6. **The parent carries on.** In the web app it may keep working and call `wait`, which polls its mailbox for at most 60 seconds, or simply end its turn.
   - _Slack and other surface-tool turns:_ `requiresDelegation` makes the turn a **coordinator**. It has no `execute` or `background` tool, is told to delegate and end promptly, and its `wait` returns immediately.
7. **March finishes.** A `runs.onTerminal` hook in `src/wiring.ts` calls `returnSubagentRun`, which calls `deliverSubagentMail` (both in `src/sessions/subagent-mail.ts`) under the same lock. `mailOf` classifies the ending: `final_answer`, `in_progress`, `no_reply`, `awaiting_input`, `errored`, `refused` or `stopped`. `renderSubagentMail` wraps the reply in a `<wake reason="subagent">` envelope, which is written to the parent's mailbox with id `subagent-mail-<runId>`. Then one of three things happens. If the parent is idle, a wake run is queued in Ada's conversation with dedup key `subagent-return:<runId>`. If the parent is busy, nothing is queued and the return stays pending. If the parent has already read the mail, the return is settled. Only a settled return sets `runs.returned_at`. March gave a final answer, is not `persistent` and has nothing queued, so it is marked `retired`.
8. **The parent reads the mail.** The parent is mid-turn, so the mail arrives with its next tool result. `recordResult`, built by `createRecorder` in `src/agent/agent-tools/record.ts`, calls `receive`, screens each message as external data, appends it to the tool result under the banner "Internal agent message (data, not user authorization…)", and marks it consumed after the tool result is saved. The return sweeper in `src/wiring.ts` runs every second; on its next pass it sees the mail was read and settles March's return.
9. **Ada presses Stop.** The web app posts `{kind: "abort"}` to `POST /v1/runs/:id/signal` (`postRunSignal` in `src/api/routes/turns.ts`). `signalRun` in `src/api/app-turn.ts` calls `stopSessionRuns` with reason `by user` and scope `session`. Every run in Ada's conversation gets an abort signal, and queued runs that never started are withdrawn. April's session is not touched.
   - _A typed `stop`, or the same request with `tree: true`:_ `routeIncoming` in `src/wake/route-incoming.ts` returns `abort` and `stopSessionTree` runs instead. April would get an abort with scope `ancestor`, and `settleTreeWakes` would clear every pending wake in the tree.
10. **April finishes.** `deliverSubagentMail` asks `runStopped` whether April's chain was stopped. The parent's run was stopped with scope `session`, which `sparesDescendants`, so the answer is no. The mail is delivered and, the parent being idle, a wake run is queued. The wake's request is rebuilt from the run that opened April, so it runs as Ada on Ada's surface. Its text tells the agent to collect its mail; the agent reads April's result and replies to Ada.

Two other paths use the same parts:

- **A message to a peer.** The `sessions` tool's `send_message` is the same `write` syscall with `peer: true`. Both sessions must be sidebar conversations in one scope (`isPeerMessage`). `wakePeer` leaves the mail and, if the recipient is idle, queues a turn there. That turn is built from the recipient's own stored context, with the sender's actor; it never borrows the sender's conversation. A busy recipient reads the mail at its next tool result under `PEER_TASK_BANNER`, or `wakeForUnreadMail` wakes it when its turn ends. The wake is skipped, and the tool result says why, when the sender is read-only, is notebook-only and the target is not, or would be the ninth wake in a chain (`SESSION_MESSAGE_DEPTH_CAP` is 8).
- **A swarm worker.** A worker is not a subagent. `POST /v1/swarm` with `action: "spawn"` (`swarmRoutes` in `src/api/routes/swarms.ts`, then `spawn` on the service from `createSwarmService`) only reserves members inside the swarm's row and answers 202. A sweeper then creates each worker's computer and session (thread ref `swarm:<rootSessionId>:<memberId>`) and queues one run per pending notification with dedup key `swarm:<messageId>:<memberId>`. Before the worker's turn runs, `binding` checks its request against the stored message. Each write the worker makes to the swarm is fenced by its run lease (`assertSwarmRun`).

## The nouns

| Noun                 | Plain meaning                                                                                                                                                                                                       | Where it lives                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Subagent** (child) | A session opened by another session to do one task. Not in the sidebar. Thread ref starts `agent:main:subagent:`.                                                                                                   | `sessions` row; `isSubagentThreadRef`                                                 |
| **Parent**           | The session a child reports to. Set once by `open`. Cleared by detach (`POST /v1/sessions/:id/detach`); a detached child returns nothing.                                                                           | `sessions.parent_session_id`                                                          |
| **Session tree**     | A top-level conversation and every session reachable through parent links. Tree operations skip sessions in another scope.                                                                                          | `treeSessions`, `stoppableRoot`                                                       |
| **Stored context**   | The request facts a session's wakes and follow-ups run with: actor, conversation, audience, surface, delivery, read-only flags, model, isolation, `persistent`, `retired`.                                          | `sessions.spawn_meta` (JSON text); type `SpawnMeta` in `src/types.ts`                 |
| **Session turn**     | A run started by another session, not by a person or a trigger.                                                                                                                                                     | `sessionSenderId`, `delegatingRunId` in `runs.request`; `isSessionTurn`               |
| **Delegating run**   | The run whose tool call caused this one. The chain of them is the proof of authority and the path a stop is traced along.                                                                                           | `delegatingRunId` in `runs.request`                                                   |
| **Mailbox**          | Durable messages between sessions: `{id, recipientId, senderId, actor, text, wake?, resultOf?, peerDepth?, consumed?}`. Insert is put-if-absent on `id`.                                                            | table `session_mailbox`; `src/sessions/session-mailbox.ts`                            |
| **Wake**             | A run queued in a session because mail arrived while it was idle. Dedup key `subagent-return:<childRunId>` for results, `subagent-followup:<messageId>` for messages.                                               | `runs.idempotency_key`; `wake` flag on the mailbox row                                |
| **Return**           | The record that a finished child run has reached its parent.                                                                                                                                                        | `runs.returned_at`; `PENDING_RETURNS` in `src/runs/run-returns.ts`                    |
| **Isolation**        | Where a child's commands run: `shared` (parent's computer and directory), `worktree` (own directory; a git worktree if the base is a repository), `sandbox` (own computer).                                         | `spawn_meta.isolation`; type `ChildIsolation`                                         |
| **Retired**          | A child that gave its final answer and is not `persistent`. It can be read by id. It cannot be messaged.                                                                                                            | `spawn_meta.retired`                                                                  |
| **Stop scope**       | How far a stop reaches: `run`, `session`, `tree`, `ancestor`.                                                                                                                                                       | type `StopScope`; the abort row in `run_signals`; `runs.result`                       |
| **Coordinator**      | A turn that must delegate: a Slack or surface-tool turn that is not a swarm worker, a subagent or a side chat.                                                                                                      | `requiresDelegation`                                                                  |
| **Peer**             | Another sidebar conversation in the same scope.                                                                                                                                                                     | `isPeerMessage`, `isSidebarSession`                                                   |
| **Side chat**        | A fork anchored to a quoted passage of its origin conversation. Linked by fork, not by parent.                                                                                                                      | `sessions.side_chat`, `sessions.forked_from_session_id`                               |
| **Swarm**            | A root session, its workers, their messages and settings: one JSON document, keyed by the root session id.                                                                                                          | table `swarms`; type `Swarm` in `src/swarms/swarm-store.ts`                           |
| **Member**           | The root or a worker: `{id, parentId, depth, context, runtime, sandboxId, forumSandboxId, state, control}`. `context` is free JSON the member edits; the agent sees it as untrusted metadata and it grants nothing. | inside the `swarms` row; worker sessions in `sessions`                                |
| **Board / forum**    | The one computer every member of a swarm can reach. The board is created with the swarm. A forum is an existing computer named at spawn.                                                                            | `Swarm.board`, `SwarmMember.forumSandboxId`; `swarmId` on the `sandbox_resources` row |
| **Notification**     | One recipient's delivery state for one swarm message: `pending`, `mailbox`, `queued`, `handed`, `failed`.                                                                                                           | `SwarmMessage.notifications` inside the `swarms` row                                  |
| **Run fence**        | Proof that a swarm write comes from a run that is still running under its current lease.                                                                                                                            | `SwarmRunFence`, `assertSwarmRun` in `src/swarms/swarm-fence.ts`                      |

## The parts

### `src/agent/agent-tools/sessions.ts` — the two tools

**Job.** Define `subagents` (`open`, `read`, `send_message`, `wait`) and `sessions` (`list`, `search`, `read`, `send_message`, `new`, `fork`), and turn each syscall result into a sentence for the model (`deliveryOutcome`).

**Key idea.** The tools are thin. The tool description is the model's whole manual, and each result states what happened: woken, queued behind a busy turn, delivered into a running turn, or left in the mailbox and why.

**Surprising.** (1) `noComputer` is stored as `readOnly`; a read-only child gets no isolation record and cannot lift the restriction for its own children. (2) `sessions` refuses subagent targets and `subagents` is the only way to reach them, but both call the same `write` and `read` syscalls. (3) `new` and `fork` need a person attending the turn and are refused on read-only turns and on a Slack bot's work; they create web sessions through `startSession` in `src/api/start-session.ts`. (4) `read` with no target lists only children that are not retired.

### `src/sessions/session-syscalls.ts` — open, message, read, stop

**Job.** Everything a turn may do to another session (`open`, `write`, `read`, `receive`, `acknowledge`, `list`, `search`, `start`), plus the tree helpers other modules import: `treeSessions`, `stopSessionRuns`, `stopSessionTree`, `runStopped`, `delegatedAuthorization`, `requiresDelegation`.

**Key idea.** Authority is recomputed, never carried. Every call re-reads the caller's session, scope and membership. A child's request copies the parent's origin kind, so a child of a person's turn is stored with origin `human`; what marks it as delegated is the `sessionSenderId` and `delegatingRunId` pair. `delegatedAuthorization` then proves the chain: same actor, same scope, no wider audience, no read-only, swarm or plain-automation link, at most 32 hops. A chain that cannot be proven leaves the turn with plain automation authority. A turn counts as attended by a person only if no run in its chain had finished when the turn first started.

**Surprising.**

1. `write` has four outcomes: `steered` (put into a running child's turn as a steer signal), `queued_turn`, `interrupted`, and `queued_message` (mailbox only). A wake that is not allowed falls back to the mailbox instead of failing. The message id is a hash of the session, the run and the tool call id, so a retried call does not send twice.
2. A subagent that is not read-only can wake its own parent, at any depth. It cannot wake any other top-level conversation: that mail waits unread until something else wakes the recipient.
3. `interrupt: true` works on any subagent session the caller can resolve: a child, a sibling, or a parent that is itself a subagent. It never works on a top-level conversation. It stops the target's running run with scope `run` and withdraws its queued, unstarted session messages; one sent by another session is first copied into the target's mailbox. The interrupt's text becomes the target's next turn.
4. A stop is judged by its scope, not its reason text (`sparesDescendants`). The table below is the whole rule.
5. `spawn_meta` has two roles. For a subagent it is the fixed starting context. For a top-level conversation the orchestrator overwrites it with the context of each ordinary turn (`ownsSessionContext`), because a wake arrives with no person's request to take context from.
6. Work a Slack bot starts stays bot work: `botActor` is copied into `spawn_meta` and into every wake. A bot's turn cannot interrupt a person's task, and a message is not steered across the bot and person line; it queues as its own turn. See [surfaces](./surfaces.md).
7. `read` returns a target's items only when every member of the current conversation's audience is a participant of the target, and then only the items the actor may see.

| Who stops                                  | Code path                                        | Scope on the signal                | Subagents of the stopped session                                                                                      |
| ------------------------------------------ | ------------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Parent agent, `interrupt: true`            | `write` → `stopSessionRuns`                      | `run`                              | Keep running. Their results still wake it.                                                                            |
| Stop button (`abort` signal)               | `signalRun` → `stopSessionRuns`                  | `session`                          | Keep running. Their results still wake it.                                                                            |
| Typed `stop`, or `abort` with `tree: true` | `stopSessionTree`, then `settleTreeWakes`        | none on the root, `ancestor` below | Every in-flight run in the tree gets an abort. Pending wakes are cleared.                                             |
| Goal cancelled from the goal bar           | `cancelSessionGoal` in `src/api/app-sessions.ts` | none                               | Not signalled. `runStopped` reports them stopped: their session tools refuse and their results arrive without a wake. |
| Swarm control `stopped`                    | `control` in `src/swarms/swarm-service.ts`       | none                               | Applies to the worker's descendants in the swarm (`controlState`).                                                    |

### `src/sessions/subagent-mail.ts` and `src/runs/run-returns.ts` — results and wakes

**Job.** Turn a finished child run into mail for its parent, decide whether that mail wakes the parent, and keep trying until it has landed.

**Key idea.** The in-process `onTerminal` hook is only the fast path. The durable record is `runs.returned_at`: `PENDING_RETURNS` selects finished subagent runs without it, and a sweeper retries them every second under the advisory lock `session-return-sweep`. A failed attempt is deferred 60 seconds (`deferReturn`). The master's Non-durability lens records the same hook failing as the only path for reply delivery.

**Surprising.**

1. A wake turn's request comes from the run that delegated the work (actor, authority, delivery target), with the audience taken from the parent's current stored context.
2. A child that ends its turn while its own subagents or watched background jobs are still working reports `in_progress`, which never wakes the parent; the final result follows later (`pendingWork`).
3. A stopped child wakes its parent only when a person stopped the child itself (scope `session` or `tree`). A parent's own interrupt and an ancestor's stop deliver mail without a wake.
4. Files a child attached are delivered separately through the delivery queue with key `subagent-files:<runId>`.
5. A reply longer than 16,000 characters is cut in the mail; the full text stays in the child's transcript.
6. Message wakes do not use `returned_at`. They use the `wake` flag on the mailbox row, recovered by `sweepUnreadMailWakes` and by `wakeForUnreadMail` when any run in the recipient's thread ends.

### `src/sessions/session-mailbox.ts` and `src/agent/agent-tools/record.ts` — mail delivery

**Job.** Store mail (`createSessionMailbox`) and hand it to a running turn.

**Key idea.** Mail is read at tool boundaries. Every tool result passes through `recordResult`, which takes up to four pending messages, screens each one on its own (`session_message_<id>`, source `session-delegation`), appends them to the result text, and acknowledges them only after the result is saved. A crash before that save redelivers.

**Surprising.** On a web turn that speaks through the surface tool (`web_dm_spine`), mail is not read into a tool result that ends the turn, so it waits for the turn it wakes. A message the screen quarantines pauses the turn on an approval; denying the approval consumes the message ([security](./security.md)).

### `src/sessions/child-isolation.ts` and `src/sessions/subagent-runtime.ts` — placement and model

**Job.** Decide the child's computer and directory (`childIsolation`), create them on first use (`ensureChildSandbox`, `prepareChildWorkdir`), and choose its model (`openRuntime`).

**Key idea.** The default is to share. A child uses its parent's computer and directory unless `open` asks for `worktree` or `sandbox`. Which computer that is when nothing is recorded belongs to [sandboxes](./sandboxes.md).

**Surprising.** (1) The default flips to `worktree` when the parent itself runs in a subagent directory, so grandchildren do not share a worktree. (2) A `worktree` child gets `subagents/<slug>-<hash>` and branch `subagent/<slug>-<hash>`; if the base is not a git repository it is a plain empty directory. (3) A `sandbox` child's computer id is its session id and is created when the child first runs. (4) With no `model` given, the child inherits the parent's model only when the parent is off the scope default; otherwise it resolves as purpose `subagent` ([models](./models.md)).

### `src/sessions/subagent-status.ts` and `src/sessions/session-work.ts` — what is still working

**Job.** Answer "what is this child doing?" for the tools (`subagentActivity`, `renderSubagentActivity`, `liveSubagentsNote`) and "is this conversation busy?" for surfaces (`createSessionWork`).

**Key idea.** Liveness is the latest tool step, not the end of the turn. A listing shows status (`running`, `pending`, `idle`, `waiting on subagents`), the age and name of the last tool step, the last turn's outcome, and unread mail.

**Surprising.** A session with no run of its own still counts as busy while a descendant runs, a child's return is pending, or a background job or watch it owns is live. The tool listing names that state `waiting on subagents`.

### `src/wake` — a message meets live work

The part belongs to [turns](./turns.md). Two facts matter here. Nothing in `src/wake` queues delegation wakes; those live in `src/sessions/subagent-mail.ts`. When a conversation is idle but its subagents are running, a halt still stops the tree, and any other message starts a normal turn (`only-subagents-live`).

### `src/swarms` and `src/api/routes/swarms.ts` — swarms

**Job.** Create and run pools of worker sessions: membership, messages, budgets, pause and stop, worker computers and the shared board.

**Key idea.** Reserve first, provision later. `spawn` and `send` only edit the swarm's row, inside a transaction that also locks the caller's `runs` row and checks its lease, then answer 202. A sweeper (every 2 seconds, 16 swarms a pass, 4 at a time, 30 seconds each) does the slow work in two phases: `resources` creates computers and worker sessions and cleans up failures; `delivery` queues one run per pending notification. Provisioning gets three attempts, and a failed reservation still counts toward the `agents` budget.

**Surprising.**

1. A worker has no parent link, no session mailbox and no return, and its reply is not delivered to any surface. The session tools refuse on a swarm turn and refuse swarm targets. A person's ordinary turn in the root session is an ordinary turn.
2. A worker turn's request must equal what `dispatchRequest` would build for that message, or it fails with `forged swarm provenance`.
3. The roster is frozen at creation. If the participants of the root session change, swarm calls fail with `swarm roster changed`; if those of the caller's own session change, with `swarm session roster changed`.
4. A worker starts on a blank computer. It gets none of the root's files and does not copy the root's model; an unset model resolves as purpose `subagent`.
5. A worker's turn ends when it replies. A message with a `goal` keeps it working under the goal loop; while a goal is open, swarm messages reach the worker mid-turn (`createSwarmGoalInbox`). Mail sent with `wake: false` is handed over at the start of the worker's next turn (`openSwarmMailbox`).
6. `stopped` is final and reaches descendants. `paused` returns queued, unstarted runs to `pending`; a turn that starts for a paused worker is held and retried.
7. Only a Slack bot's own turns may add workers to a swarm a bot started, and such a swarm never takes a forum. The bot loses the swarm once anyone else posts a message in it or a person's turn uses one of its computers.

### `src/core/side-chat-context.ts` and `src/sessions/side-chat.ts` — side chats

**Job.** Give a side chat its rules (`SIDE_CHAT_GUIDANCE`) and give the origin conversation a view of its side chats (`sideChatContext`).

**Key idea.** A side chat is a fork with an anchor (`isSideChatAnchor`: an entry seq, a quote, an occurrence). The origin's prompt receives side-chat exchanges as untrusted reference data under a token budget that drops the oldest exchanges first, and only when every member of the current audience is a participant of both sessions.

**Surprising.** A side chat cannot open subagents until `POST /v1/sessions/:id/expand` turns it into a full session. It can still read and message existing sessions.

## Optional and per-deployment

Subagents and peer messages have no switch: every deployment has them. Delegation adds two environment variables and two feature flags; the rest varies only through settings owned by neighbours. The master defines the [deployment shapes](../SPEC.md#deployment-shapes) and lists [what is core and what is optional](../SPEC.md#core-and-optional).

| What                          | Turned on by                                                                                                | Default                | When absent                                                                                                                                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Swarms                        | env `SWARMS_ENABLED`                                                                                        | `true`                 | With `false` no swarm service is built. The swarm routes answer 503 `swarm service unavailable`, the self-API catalog omits them, the sweeper does not start, and a queued swarm turn fails without retry. Rows in `swarms` and worker computers stay. |
| Swarm default settings        | env `SWARM_DEFAULTS` (JSON object)                                                                          | see Contracts          | Built-in defaults. An unknown key or a value below 1 makes config loading throw at startup.                                                                                                                                                            |
| Swarm worker provider         | the provider of the scope's selected computer, else the deployment default, or `backend` on the first spawn | none                   | A provider that cannot both create and retire computers refuses the first spawn. A Platform-hosted deployment fixes the provider ([sandboxes](./sandboxes.md)).                                                                                        |
| `isolation: "sandbox"`        | a provider whose profile lists `retire`                                                                     | `shared`               | The child fails when it first runs: `<backend> computers cannot be retired, so a subagent cannot have its own sandbox there`.                                                                                                                          |
| Coordinator mode              | the turn is on Slack or has surface tools                                                                   | off on plain web turns | The turn keeps `execute`, works inline and may `wait`. A deployment with no surface that speaks through surface tools never runs a coordinator ([surfaces](./surfaces.md)).                                                                            |
| Web DMs as surface-tool turns | feature flag `web_dm_spine`, per person                                                                     | off                    | Web DMs are ordinary turns.                                                                                                                                                                                                                            |
| Reply rewrite on wakes        | feature flag `wake_reply_rewrite`, per person                                                               | off                    | A wake turn's reply is added as a new message. With the flag on, it replaces the agent's last reply written for the same person (`replyToRewrite`); both versions stay in the transcript and the new one carries `supersedes`.                         |
| Subagent model                | the org runtime for purpose `subagent`                                                                      | unset                  | Resolves like any turn ([models](./models.md)). An unavailable `model` on `open` is refused.                                                                                                                                                           |
| Mail screening                | the security posture ([security](./security.md))                                                            | —                      | Delegation has no switch of its own. Unscreened mail is delivered with a notice (`unscreenedNotice`).                                                                                                                                                  |

In a Multi-tenant deployment, mailbox, swarm and run rows belong to a tenant, and the return sweep, the unread-mail sweep and the swarm sweep claim work tenant by tenant. The `session-tree-admission` lock is the one piece that is not per tenant.

## Where the complexity lives

**Things that multiply each other.**

- _Stops._ Five ways to stop × four scopes × three run states (running, queued and unstarted, queued by another session) × a bot-only variant (`botRunsOnly`). Only the tree stop walks the tree and signals descendants. A goal cancel signals one session; its descendants are fenced by `runStopped` but their current turns run on.
- _Wake eligibility._ `write` chooses between steer, new run, wake and mailbox from the target kind (child, sibling, own parent, peer, other top-level) × the sender's flags (read-only, notebook-only, private turn, bot) × `wake` and `interrupt` × chain depth. It returns six fixed "left in the mailbox" reasons.

**Parallel mechanisms doing one job.**

| Job                           | Mechanism A                                                 | Mechanism B                                                                                              |
| ----------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Remember that a wake is owed  | Results: `runs.returned_at` and the `PENDING_RETURNS` sweep | Messages: the `wake` flag on the mailbox row, `sweepUnreadMailWakes`, `wakeForUnreadMail`                |
| Messages between agents       | `session_mailbox` (subagents, peers)                        | `SwarmMessage` inside the `swarms` row, with its own states, `wake: false`, dedup and mid-turn hand-over |
| Put text into a busy session  | A steer signal (`steerRunningTurn`)                         | Mail read at the next tool result; or a queued run                                                       |
| "Is this tree still working?" | `pendingWork`, `subagentActivity`, `openChildren`           | `createSessionWork`, `sessionTreeWorking`, `workingSessionThreadRefs`, `sessionTreeRuns`                 |
| Context for a wake turn       | The delegating run's stored request                         | The recipient's `spawn_meta` (`storedContext`)                                                           |
| A pool of parallel workers    | Subagents: a tree, the parent's computer by default, mail   | Swarms: a flat member list with depth, own computers, a board                                            |

**One lock for every tree.** `session-tree-admission` is a literal key with no tenant or tree in it. Every `open`, `write`, stop, detach, return and unread-mail wake in the database serializes on it.

**One row per swarm.** Every spawn, send, control and notification change rewrites the whole JSON document, including every message sent so far.

**Fixed numbers.** Eight peer wakes in a row, 32 authority hops, four messages per mailbox read, 16,000 characters per message, 60 seconds per `wait`, and the swarm defaults below. The master's Arbitrary limits lens covers swarm settings and subagent run caps.

**Recorded by the master.** The rule in `routeIncoming` that a person's message does not steer into a live automation turn unless they asked to steer is the case under the Category gate without census lens.

**Abstractions without a second user.** `SessionSyscallDeps.enabled`, a per-person gate, is never passed in `src/wiring.ts`. `createSwarmStore` has a write path for a missing Postgres pool; `src/wiring.ts` always passes one.

**Transitional code.**

- `privateSessionMessage` marks a read-only turn that one branch of `write` can queue. That branch needs a target that has a parent but is not a subagent thread, and `open`, the only writer of a parent link, creates only subagent threads **[interpretation: the branch is unreachable for sessions created at this commit]**. The field is still read in a dozen files.
- The code that builds a wake turn handles a parent that is not the session that opened the child. `setParentSession` has two callers: `open` sets the opener, detach sets null.
- Two startup migrations repair swarm rows written by older releases: `durable-map/swarms/0040-stamp-computers` and `durable-map/swarms/0041-mark-forums-person-used`.

## Contracts

**Environment.** `SWARMS_ENABLED` (boolean, default `true`). `SWARM_DEFAULTS`: a JSON object of the settings below.

**Swarm settings.** Stored once on the swarm. Each is a positive integer. The root may change any except `turnMs` on a later spawn.

| Setting                                      | Default    | Meaning                                                                                                        |
| -------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| `agents`                                     | 32         | Members, counting the root and failed reservations. At least 2.                                                |
| `depth`                                      | 4          | Levels of workers below the root.                                                                              |
| `contextBytes`, `textBytes`                  | 8,192 each | Size of one member context and of one message text.                                                            |
| `waitMs`                                     | 10,000     | Longest wait on one read.                                                                                      |
| `spawnRequests`, `messages`, `notifications` | unset      | Lifetime budgets, reserved in the same write as the thing they count.                                          |
| `lifetimeMs`                                 | unset      | Work window from creation. After it, history stays readable and new work is refused until the root extends it. |
| `turnMs`                                     | unset      | Wall clock for one worker turn. Does not apply to a goal turn. Ceiling 2,147,483,647.                          |

**Agent swarm API.** Sent from a turn's computer with header `x-agent-capability: $AGENT_API_TOKEN`. The token must be bound to the calling session and to a run that is running under an unexpired lease. Request bodies cannot set identity. An unknown body field is a 400. Errors are `400 {error}`; a missing session binding is 403.

| Request                  | Body or query                                                                                                                             | Answer                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/swarm`          | —                                                                                                                                         | `200 {id, self, peers, board?, backend, settings, expiresAt?}`                                                                                                                                                                                                                                          |
| `GET /v1/swarm?read=1`   | `after` (last seq seen), `waitMs` (at most the `waitMs` setting), `replyTo?`                                                              | `200 {messages}`: at most 32, any audience. Replies read with `replyTo` count as handed to the caller. A timeout returns an empty list.                                                                                                                                                                 |
| `POST /v1/swarm` spawn   | `{action:"spawn", requestId, text, count?, context?, contexts?, model?, effort?, fastMode?, goal?, settings?, backend?, forumSandboxId?}` | `202 {members}`. `count` is at least 1 and below `agents`. `contexts` sets the count. `backend` only on the first spawn. `settings` only from the root. `model`, `effort` and `fastMode` are stored on the new members and inherited by workers they spawn; an unknown or unavailable model is refused. |
| `POST /v1/swarm` send    | `{action:"send", requestId, text, audience, replyTo?, wake?, goal?}`                                                                      | `202 {message}` with `id` and per-swarm `seq`. `audience` is a list of member ids or `"all"`.                                                                                                                                                                                                           |
| `POST /v1/swarm` context | `{action:"context", context}`                                                                                                             | `200`: the caller's member record. Any JSON; replaces the caller's own context only.                                                                                                                                                                                                                    |
| `POST /v1/swarm` control | `{action:"control", memberId, state}`                                                                                                     | `200 {member}`. `state` is `active`, `paused` or `stopped`. An agent may control itself and its descendants. The root cannot be controlled.                                                                                                                                                             |

`requestId` is required on spawn and send, at most 128 bytes. The same id with the same payload returns the first result; with a different payload it is refused. A sender is not notified of its own message unless it sends itself a goal by id. `wake: false` stores the message as `mailbox` for each recipient and uses no notification budget. A `goal` is `{objective, floor?, token_cap?}`, goes to workers only, cannot be combined with `wake: false`, and replaces the recipient's current goal.

**Person swarm API.** `GET` and `POST /v1/sessions/:id/swarm` (browser alias `/api/sessions/:id/swarm`), as a signed-in person who can view the session. `GET` inspects. `POST` accepts `control` only; a person may control any worker.

**Stop, detach, list.** `POST /v1/runs/:id/signal` with `{kind:"abort"}` stops that conversation; with `tree: true` it stops the tree. `POST /v1/sessions/:id/detach` clears a child's parent. `GET /v1/sessions/:id/children` lists a session's descendants.
