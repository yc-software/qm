# Mattermost as another agent surface

We'd like Mattermost alongside Slack and the web UI.

Mattermost is the self-hosted alternative to Slack: free, runs on your own servers,
and it covers the orgs that can't or won't put their chat in someone else's cloud. We
self-host everything we run, and a Mattermost bot is how our team would actually talk
to QM.

The integration surface is close to Slack's: a bot account authenticated with a
personal access token, an outbound WebSocket for real-time events, and webhooks for
messages. Like Slack's Socket Mode, there's no public URL, domain or TLS to set up —
which matters even more for deployments on VPNs or air-gapped networks, where the web
UI isn't always reachable either.

A few points that came up thinking it through:

- threads are sessions: when a thread is archived or deleted, the sessions bound to it
  need to close with a reason;
- Mattermost renders standard markdown, so most of the existing message formatting
  should carry over as-is;
- long messages should chunk on paragraph boundaries, never inside a code fence;
- replies should mention whoever asked, with mentionable roles coming from config.

Same shape as the Discord proposal: a separate service on the chassis, talking to core
over the HTTP API the way web-ui does, keeps Mattermost opt-in behind a bot token.
