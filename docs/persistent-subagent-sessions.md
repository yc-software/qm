# Persistent subagent sessions

A delegated task runs in a durable session with its own transcript and a mutable parent. The `session` tool opens children, reads accessible transcripts, and sends attributed messages. Parentage is organization data: it survives restarts and can be changed independently of the original delegation.

## Lifecycle

`session.open` accepts a task, title, model, harness, thinking level, and read-only preference. Reusing its request key recovers the same child and initial run after a lost receipt; using that key for different work is rejected. Children inherit the caller's scope and audience. Read-only delegation cannot be upgraded to writable execution. The session tree admits at most ten pending or running qm runs, including direct turns and completion wakes.

`session.write` queues a separate screened turn, including when the child is already running. Agent messages never inherit an active human turn’s authority. An interrupt aborts running child work. Messages identify their sending session. Late signals retain durable receipts until replay succeeds; human replays retain their sender and runtime settings and revalidate current access.

An ordinary-session target receives a separate private, read-only turn. The message does not steer an active people-facing turn or inherit an external delivery destination. These private wakes can inspect context and reply with the session tool. Replies remain private and read-only, queue without steering active work, and never generate automatic parent returns. They cannot delegate or interrupt. A persisted eight-hop limit bounds reply chains. Writable child execution remains subject to its existing tool and credential authorization; a session message is not an independent guarantee against external actions.

Read access checks scope, current participant access, audience visibility, and participant tenure. Sending and adoption require current scope access. A wider target audience cannot receive a narrower source's contents.

## Parent changes and completion

Subagents appear as clickable, draggable inline chips in their parent conversation’s collapsible tool rows, outside the sidebar session list. Dragging a chip into the sidebar detaches it and makes it a top-level session. The web UI does not offer reparenting onto other sessions. A child transcript links back to its current parent. The underlying parentage API rejects cycles, unauthorized changes, and cross-scope moves.

A terminal child run produces a deduplicated completion wake for its current parent. The parent request supplies the delivery destination and audience; the child's original destination is not reused after adoption. A freshly adopted parent without runtime context leaves completion pending until that context exists. Detached children produce no automatic parent return.

Terminal receipts live in the run store. A paginated sweep retries pending returns after restart and continues past blocked entries. Completion receipts are acknowledged only after enqueue succeeds. Silent completions use a generic notice rather than borrowing text from a later child run.

## Storage and scope

The session migration adds parent and spawn metadata. The run migration adds terminal-return acknowledgements and an index restricted to unreturned terminal child runs. Signal replay uses the existing signal acknowledgement columns.

This change does not add Slack dispatch, automatic thread placement, acknowledgement policy, transcript merging, or native-harness subagent management. The ten-run limit governs qm session runs; native harness execution is outside that accounting.

## Swarms

Swarm workers continue to coordinate through the swarm API, which owns their computer assignment, membership, and execution budgets. Session tools cannot spawn or send from swarm turns, send to swarm workers, or adopt a child under a swarm worker. Ordinary human turns in a swarm root remain ordinary session turns. All session-generated work is automated, preserving unattended authorization.
