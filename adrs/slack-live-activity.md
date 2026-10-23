# Show what the agent is doing while a Slack turn runs

Jake from CargoLabs here. We run qm on Fly via the deployment repo, and our team talks to it mostly through the Slack bot.

The problem, in one line: while qm works on a longer reply, Slack shows nothing, so people can't tell "still working" from "dead." Our channels are full of "@qm are you still there?" and "@qm are you working?" and the honest answer is that we wait five-plus minutes and guess. Sometimes it really is down (an expired provider key, a bad config) and the silence looks identical.

Today the only always-on signal is the ack reaction, which is great as a "got it" but says nothing after that. The task checklist and the first pre-tool text block only show up when the agent happens to produce them. The Slack README describes a "⚙ Working…" status message that streams the reply in place, but as far as we can tell that message is never posted by the current plugin. Tool activity never reaches Slack at all.

What we'd like is the equivalent of what Buzz does with its agents: a small live line under the conversation that says what the agent is doing right now.

Concretely, two layers:

1. A baseline that works on any Slack plan. For DM and @mention turns, post one status message right after the ack reaction and keep editing it in place: something like "Working… · looking up Stripe payment · step 4 · 48s". Tool name, step count, elapsed time. Throttle edits to every few seconds so chat.update rate limits are never a problem. When the reply lands, replace the status with the reply (or delete it). The core already records tool_call and tool_result entries per run and the plugin already edits the task-list message in place, so the pieces seem to exist. Ambient (unprompted) thread turns should stay silent exactly as they do now.

2. Slack's native agent status where the workspace supports it. Slack's Agents & AI Apps feature has the "is thinking…" status under the composer plus streamed replies, which is the closest thing to the Buzz bar. Issue #737 (from the PR by @MiscMich) already proposes this. We'd use it the day it ships; adding assistant:write to the manifest is easy on our side. Layer 1 should remain the fallback when the native APIs aren't available.

What we are not asking for: reasoning text or tool arguments in Slack. High-level activity only, the way the web UI timeline already summarises it. That keeps the same trust boundary the Slack surface has now.

Happy to test either layer against our live workspace and report back.
