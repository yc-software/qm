# Historical transcript-grouping proposal

This rejected September 21, 2026 proposal joined adjacent assistant rows when the second row contained session-tool activity. The accompanying patch preserves the actual uncommitted `chat.ts` and `shell.css` changes against public commit `e29acebd6c65bc929aab454b3a5b7dafb122ede6`. It includes surrounding activity-display work from the same proposal; supporting files and tests are omitted. No behavior has been adapted to current main.

The specific condition is named `delegationContinuation`. It checks adjacent message roles, their text, and the next message's `session` tool activity, then shares their footer.

The design review concluded:

> It joins two adjacent assistant rows only when the second contains subagent activity. It won’t reliably handle multiple commentary messages, intervening tools, or resumed turns.
>
> The general fix is to group transcript events by their actual turn/run identity, then render commentary, tool activity, and delegation inside one response with one footer. Streaming and reloaded history should use that same grouping.

This is historical evidence for the Wall of shame, not a proposed UI change. Do not apply or merge the rejected behavior.
