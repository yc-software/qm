# Historical Slack task-completion proposal

This rejected September 21, 2026 proposal tried to keep Slack acknowledgments alive across delegation by reconstructing completion inside the Slack surface. The accompanying patch is the recovered `src/slack/task-ack.ts` portion, against public commit `5d3b6dc2`. It is an excerpt, not the complete runnable change: supporting run-store, orchestration, and test edits are omitted.

The patch was reconstructed from the recorded edits and formatted with the repository's formatter. It preserves the checks for descendant runs, the latest conversation run, acknowledgment records, and outbox key prefixes. It has not been adapted to current main.

The design review concluded:

> Slack now reconstructs task completion from descendant runs, mailbox returns, the latest conversation turn, delivery-key prefixes, and acknowledgment records. That lifecycle logic belongs in core.
>
> Checking the latest conversation turn can tie an old acknowledgment to unrelated new work.
>
> Using a finished acknowledgment record as proof of message delivery mixes presentation state with delivery state.

This is historical evidence for the Wall of shame, not a proposed runtime fix. Do not apply or merge the rejected behavior.
