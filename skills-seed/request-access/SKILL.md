---
name: request-access
description: Ask a person for access to one of their keychain credentials when a command needs it and this conversation has no grant yet. The platform posts an approval card where this conversation is happening; the owner clicks it, and the blocked command re-runs.
---

# Request access to someone's credential

Use this when the keychain manifest lists a credential you need but shows no grant for this
conversation. Your own credentials in your own personal conversation never need this.

## Request

One call, from this session or any sub-agent. The approval belongs to the whole conversation,
so every session in it sees the same grant.

```sh
curl -fsS -X POST "$AGENT_API_URL/v1/keychain/asks" \
  -H "x-agent-capability: $AGENT_API_TOKEN" -H 'content-type: application/json' \
  -d '{"credential":"<credential id>","purpose":"<what the command will do>"}'
```

- `purpose` is one plain sentence about the command, not the whole task.
- Add `"requestedMode":"once"` only when a single command is all you need. The default lasts until revoked.
- If a request for that credential is already pending, the same one comes back. Don't ask twice.

## Where the card shows up

You don't choose. The card appears where this conversation is: the Slack thread or channel,
inline in the web session (and in its parent when you are a sub-agent), or the scheduled job's
destination. Only the credential's owner can click it; nothing said in chat is approval.

## Then

- Tell the person in one short line that you asked the owner for access. No request ids, no request text, no "paused".
- Stop. Don't retry, poll, or work around the missing credential.
- When the owner approves, this conversation re-runs the blocked command on its own. Continue with one short line.
- If they deny or it expires, say so in one line and offer another way.
