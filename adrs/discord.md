# Discord as another agent surface

We'd like Discord alongside Slack and the web UI.

Discord is the natural cheap alternative to Slack: it's free, bots are trivial to create
and run, and its bot primitives are in some ways richer than Slack's: threads, forum
channels, components, reactions. Hermes and OpenClaw both ship Discord surfaces already.
Like Slack's Socket Mode, the Discord gateway is an outbound WebSocket, so there's no
public URL, domain or TLS to set up.

Some context on where this is coming from: we run multiplayer Discord agents in production
for companies in Brazil. None of them use Slack. We've been maintaining that surface for
some months. Beyond the obvious surface plumbing any integration needs, these are some
points that came up along the way:

- threads are sessions. When a thread is archived or deleted, the sessions bound to it
  need to close with a reason;
- Discord rejects large uploads. Today the Slack surface just refuses the file as too
  large; we found it's better to publish it as an artifact and reply with a link, which
  the core already has the pieces for;
- long messages get chunked, and the chunk boundary must never fall inside a code fence,
  or the formatting breaks;
- replies should mention whoever asked, with the mentionable roles coming from config;
- one preference rather than a gap: when a thread already has a run in flight, we found it
  works better to say so than to queue silently.

I wouldn't put this in-process like the Slack plugin. A separate service on the chassis,
talking to core over the HTTP API the way web-ui does, seems cleaner and keeps Discord
opt-in behind a bot token.
