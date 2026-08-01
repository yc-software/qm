# Use Migma.ai for email campaigns in QM

Migma.ai is an email platform agents can use to create, edit, validate, send,
schedule, and track branded emails. It exposes those actions through an OAuth
MCP server at `https://migma.ai/mcp`.

I'd like QM users to connect Migma and handle email work from their existing
Slack or web conversation. A user could ask QM to prepare a campaign, review
the result, approve a send or schedule, then ask for delivery, click, bounce,
and unsubscribe results without moving the workflow into another chat.

I noticed the TinyFish OAuth MCP proposal. Connection mechanics are similar,
but use cases differ: TinyFish brings web research and automation tools; Migma
brings an email workflow with approval-sensitive sends and durable campaign
results.

Each QM user should connect their own Migma account through OAuth. Interactive
turns should use the speaker's connection. Scheduled work should use the
instruction owner's connection. One person's connection should never become a
room credential.

After connecting, QM should discover the Migma tools and call
`migma_get_capabilities` before choosing a workflow. The agent can then prepare,
edit, and validate emails, work with opted-in contacts and segments, send or
schedule campaigns, and read campaign stats and delivery logs.

Reads can follow QM's normal tool path. Sending, scheduling, and audience
changes should use QM's existing approval and audit path. The OAuth screen
should make `email:send` clear before approval, and send retries should reuse
the same idempotency key so one action cannot send twice.

Migma should remain the source of truth for emails, audiences, campaigns, and
tracking. QM does not need a Migma-specific campaign database or UI.

The end-to-end check I care about is small: connect one user, prepare a campaign
draft, pause on send approval, send it once, then read delivery and click stats
back into the same Slack or web conversation. A channel participant and an
unowned scheduled job must not be able to reuse that connection.
