# Persistent subagent sessions

A delegated task runs in a durable session with its own transcript and a mutable parent. The `sessions` tool opens children, reads accessible transcripts, and sends attributed messages. Parentage is organization data: it survives restarts and can be changed independently of the original delegation.

## Lifecycle

`sessions.open` accepts a task, title, model, harness, thinking level, and read-only preference. Reusing its request key recovers the same child and initial run after a lost receipt; using that key for different work is rejected. Children inherit the caller's scope and audience. Read-only delegation cannot be upgraded to writable execution. The session tree admits at most ten pending or running qm runs, including direct turns and explicit follow-up tasks.

`sessions.send_message` adds attributed data to a durable recipient inbox without starting a turn. Parents, children, siblings, and other accessible sessions can exchange messages. Targets accept IDs, child/sibling titles, or `parent`. Messages arrive at tool boundaries; `sessions.wait` waits up to 60 seconds for mail. Idle recipients see messages when they next use a tool. Agents should continue independent work and wait for required results before giving one combined answer.

`sessions.followup_task` explicitly queues new work for an attached child, behind any active turn. Like `open`, it takes the instruction in `task`. Stable call IDs deduplicate retries. `send_message` with `interrupt: true` aborts active child work. Messages are external data, not human authorization. Each message is screened independently of its carrier tool and persisted at the receiving session's scope. Quarantined messages remain recoverable for approval; denying the approval consumes the message. Read-only and automated authorization restrictions still apply to assigned work.

Read access checks scope, current participant access, audience visibility, and participant tenure. Sending and adoption require current scope access. A wider target audience cannot receive a narrower source's contents.

## Parent changes and completion

Subagents appear as clickable, draggable inline chips in their parent conversation’s collapsible tool rows, outside the sidebar session list. Dragging a chip into the sidebar detaches it and makes it a top-level session. The web UI does not offer reparenting onto other sessions. A child transcript links back to its current parent. The underlying parentage API rejects cycles, unauthorized changes, and cross-scope moves.

A terminal child run produces a deduplicated internal result for its current parent. With `responsive_spine` enabled for the delegating actor, a Slack or spine parent also receives a durable, deduplicated completion wake so it can report the result after ending its dispatch turn. Other parents retain passive mailbox delivery without a new run. The immutable delegating run supplies the actor, authorization, and delivery destination; the current parent request supplies the audience. A freshly adopted parent without runtime context leaves completion pending until that context exists. Detached children produce no automatic parent return.

Terminal receipts live in the run store. A paginated sweep retries pending returns after restart and continues past blocked entries. Completion receipts are acknowledged only after durable inbox insertion and any required completion wake succeed. Inbox messages are consumed after their content is persisted to the recipient transcript; an acknowledgement failure can cause redelivery. Silent completions use a generic notice rather than borrowing text from a later child run.

## Storage and scope

The session migration adds parent and spawn metadata. The run migration adds terminal-return acknowledgements and an index restricted to unreturned terminal child runs. Signal replay uses the existing signal acknowledgement columns.

The ten-run limit governs qm session runs. Coordinator turns use durable session delegation and disable provider-native subagent tools; other turns retain their existing native-harness behavior.

## Swarms

Swarm workers continue to coordinate through the swarm API, which owns their computer assignment, membership, and execution budgets. Session tools cannot spawn or send from swarm turns, send to swarm workers, or adopt a child under a swarm worker. Ordinary human turns in a swarm root remain ordinary session turns. All session-generated work remains automated. Explicit unattended grants belong to the assigning turn, never an earlier task. For `responsive_spine` participants, an attached child and its completion continuation can retain the original live requester’s sharing and author authority through verified durable run provenance. Current audience and sharing policy still apply; read-only, private-message, swarm, detached, and unrelated automated work cannot borrow that authority.

## Feature flag

`persistent_subagents` defaults off. Enable it through the existing feature-flags admin resource for individual actor scopes (`personal:<principal-id>`). The actor flag applies even when that actor works in a shared conversation. Enable only the intended people in each deployment; other deployments remain off without their own opt-in. Actors with neither `persistent_subagents` nor `responsive_spine` enabled are not offered the sessions tool, and syscall authorization rechecks these flags. Existing transcripts remain accessible.

`responsive_spine` also defaults off and is independent of `persistent_subagents`. Enable it for individual `personal:<principal-id>` scopes through the feature-flags admin API to pilot responsive Slack and spine turns. It applies to the acting person even in shared conversations. Enabled coordinators cannot use command execution, background process tools, credential execution, or provider-native delegation. They dispatch substantial work through `sessions.open`, end promptly, and receive completion wakes. Child sessions retain command tools. Web conversations without spine tools and swarm workers retain their existing behavior. Turning the flag off restores the actor's ordinary toolset and passive completion handling on subsequent turns; it does not interrupt already running work.

Messages use the existing durable artifact store under `session_mailbox`; no process-local queue owns delivery. The flag configuration is also durable and local to each deployment.
