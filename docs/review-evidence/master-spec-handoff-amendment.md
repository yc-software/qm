# Historical master-spec handoff amendment

This is the actual 30-line addition to the master spec accompanying the shared-to-personal Slack handoff feature. It illustrates the level of implementation detail accumulated in the master spec. The assessment that this level of detail is disproportionate is an editorial judgment.

The excerpt preserves the original wording, except that a personal name is replaced with `[name omitted]`. Unrelated context and implementation files are omitted.

## Original addition

**Workspace context is not universal.** A public/shared workspace and a user's private workspace are
different scope contexts. A workflow may start in a public place — for example a Slack channel or
team workspace — while depending on resources that exist only in one user's private workspace:
their shell environment, logged-in browser, resident CLI, OAuth wallet, memory, or private files.
The public workspace agent may not inspect, mount, or "borrow" those private resources, even when the
user who owns them is present in the public conversation. Its available context remains the public
workspace plus the audience floor.

**Agent-to-agent handoff.** When a public/shared workflow needs a specific user's private resource,
the public agent asks that user's private agent for a bounded, shareable result. The private agent
runs in the user's private workspace after that user consents, then returns only the outcome,
evidence, blocker, or artifact that is safe to share back. The public workspace never receives the
user's private memory, files, env values, browser profile, or credentials; only the private agent's
returned result crosses the boundary. The public agent chooses the target from the conversation
itself — for example, "[name omitted], check whether your `ANTHROPIC_API_KEY` is configured" targets [name omitted]'s
private agent — or asks the room who should be involved. It must not claim a user "has" a resource
unless the conversation or a non-secret resource hint says so.

**Slack implementation today.** In Slack, the handoff is shown as a short request/approval flow, not
as a second visible bot account. A channel reply that needs private help includes an internal
`ask-agent` directive; the Slack plugin strips that directive from the public message and sends the
target user a DM approval card: the channel agent is asking your private agent to run this bounded
task. If the user approves, core starts a normal DM-scoped turn for that user, so the work runs under
the user's private workspace rules. When that private turn finishes, the plugin posts only the
shareable result back into the original thread, labeled as the private agent's reply to the channel
agent. If the user declines or the private turn fails, the original thread is updated with that
status. The target must be an internal participant in the current conversation, so a public thread
cannot silently conscript an outsider. A future core-native `ask_agent` primitive can express the
same consent/run/postback contract for non-Slack surfaces.
