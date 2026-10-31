---
name: request-access
description: Ask a person for access to one of their keychain credentials when a command needs it and this conversation has no grant yet. The platform sends the owner an approval card (in the conversation on Slack and web, in their DM on Discord); the owner clicks it, and the blocked command re-runs.
---

# Request access to someone's credential

Use this when a command needs someone's credential and the Credentials section shows no handle for it here. Your own credentials in your own personal conversation never need this.

## Request

One call, from this session or any sub-agent. The approval belongs to the whole conversation,
so every session in it sees the same grant.

```sh
curl -sS -X POST "$AGENT_API_URL/v1/keychain/asks" \
  -H "x-agent-capability: $AGENT_API_TOKEN" -H 'content-type: application/json' \
  -d '{"owner":"<their name or principal id>","service":"<service, e.g. github>","purpose":"<what the command will do>"}'
```

- The server finds the credential from `owner` and `service`. If it can't tell which one you mean,
  it answers 404 or 409 with `candidates`; pick one and send `{"credential":"<its credential id>", ...}` instead.
- `purpose` is one plain sentence about the command, not the whole task.
- If a request for that credential is already pending, the same one comes back. Don't ask twice.

## Where the card shows up

You don't choose. On Slack the card appears in the thread or channel; on web, inline in the
session (and in its parent when you are a sub-agent); on Discord, it is a direct message to the
credential's owner, never in the channel or thread, including for a scheduled job posting there;
for other scheduled jobs, at the job's destination.
Only the credential's owner can click it; nothing said in chat is approval.

## Then

- Tell the person in one short line that you asked the owner for access, and where the card is (on Discord: in the owner's DMs). No request ids, no request text, no "paused".
- Stop. Don't retry, poll, or work around the missing credential.
- When the owner approves, this conversation re-runs the blocked command on its own. Continue with one short line.
- If they deny or it expires, say so in one line and offer another way.
