# A claim/heartbeat/release protocol for concurrent writes to shared scope state

Multiple sessions writing into the same room/scope memory is exactly the failure
class behind #79 (scratch-memory promotion overwriting newer edits) and the
durable-map issue in #62 — two agents, or a person and an agent, touching the same
shared state with no coordination layer between them.

We hit this exact problem running a multi-agent orchestrator that dispatches several
coding agents into the same workspace concurrently. The fix that's worked for us in
production: before an agent claims write-ownership of a piece of shared state (a
file, a worktree, a memory key), it registers a claim with an intent string and a
scope, sends a heartbeat while working, and releases on exit. A second agent trying
to claim overlapping scope gets a hard collision instead of a silent overwrite — it
waits, queues, or negotiates, it doesn't race.

For qm this could sit as a thin layer under durable-map / scratch-memory writes:
`claim(key, intent) -> write -> release(key)`, with heartbeat-based staleness so a
crashed agent doesn't hold a claim forever. It generalizes #79 instead of patching
promotion timing as a one-off, and heads off the same bug class showing up again in
crons, watches, and multi-agent room work as usage grows. Happy to sketch the
interface in more detail — this is closer to a battle-tested pattern than an idea for
us at this point.
