# Migma over OAuth MCP

I saw the TinyFish OAuth MCP proposal. Migma fits the same connection seam, but
the job is different: TinyFish brings web tools; Migma handles email work and
includes consequential writes.

I'd like a QM user to connect `https://migma.ai/mcp` with their own Migma
account through OAuth. Interactive turns should use the speaker's connection.
Scheduled work should use the instruction owner's connection. One person's
connection should never become a room credential.

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
