---
name: hand-off
description: Get work done that needs another person's own logins, files or memory. Decide whether to just do it yourself, and if not, ask that person by DM with the full request.
---

# Hand work to another person

## First, can you do it yourself?

- **Open posture** (your prompt has `## Sharing posture: Open`): do the work yourself with the
  requester's own logins. Don't hand it off.
- **Isolated:** hand off only when the work needs that person's own logins, keys, files or memory.
  Shared services and org credentials don't need a hand-off. If you only need one of their
  credentials, use the `request-access` skill instead.

## Ask them by DM

```sh
curl -fsS -X POST "$AGENT_API_URL/v1/reach" \
  -H "x-agent-capability: $AGENT_API_TOKEN" -H 'content-type: application/json' \
  -d '{"recipient":"<their name or Slack id>","text":"<the full request>"}'
```

- They haven't seen this conversation. Write out the whole request: what's needed and why.
- Start the DM with the source channel name and a permalink to the originating thread, and ask
  them to reply there (or DM the requester if they can't post there).
- One DM to that person. Never post the request in a channel.

## Then

- Say you messaged someone only after reach returns `ok: true`, and name the person it matched
  (`recipient.displayName`). If it failed or matched the wrong person, say that instead.
- Don't wait or poll for their reply.
