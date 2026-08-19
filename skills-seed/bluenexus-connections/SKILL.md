---
name: bluenexus-connections
description: Reach the user's third-party services (Slack, Notion, GitHub, Google Workspace, Telegram, and more) through their connected BlueNexus account.
---

## BlueNexus connected services

BlueNexus fronts every service the user has connected to it. One connection, many
services — you do not need a separate credential per service.

This is an OAuth connector. The user's BlueNexus token already lives on your computer as
an environment variable, the way a logged-in CLI's cached credential would:

- `$VAULT_TOKEN_BLUENEXUS_AI` — for `bluenexus.ai` and its subdomains

If that variable is empty, the user has not connected BlueNexus. Tell them to connect it
on the Keychain page. Do not ask them for a token, log it, or use another principal's
credential.

## How to call it

The endpoint is **`https://api.bluenexus.ai/mcp`** and it speaks **JSON-RPC 2.0 over
POST**. It is stateless — no session, no handshake, every call is self-contained.

Send `Accept: application/json` and you get a single JSON body back. If you send
`text/event-stream` you will get SSE instead and have to parse `data:` lines, so don't.

List what the current grant can reach:

```bash
curl -sS -X POST https://api.bluenexus.ai/mcp \
  -H "Authorization: Bearer $VAULT_TOKEN_BLUENEXUS_AI" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Call a tool:

```bash
curl -sS -X POST https://api.bluenexus.ai/mcp \
  -H "Authorization: Bearer $VAULT_TOKEN_BLUENEXUS_AI" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"<tool>","arguments":{...}}}'
```

The reply is JSON-RPC. The useful text is in `result.content[].text`; `result._meta`
sometimes carries structured extras. A tool that fails returns `result.isError: true`
with the reason in the same text field — check for it rather than assuming success.

## The tools

| Tool                    | Arguments        | What it does                                                    |
| ----------------------- | ---------------- | --------------------------------------------------------------- |
| `list-connections`      | `{}`             | Which services are connected, and as which account. Start here. |
| `read-connections`      | `{"prompt":"…"}` | Read-only task across the connected services.                   |
| `write-connections`     | `{"prompt":"…"}` | Same, but permitted to make changes.                            |
| `search-knowledge-base` | `{"query":"…"}`  | Search the user's BlueNexus knowledge base.                     |
| `add-to-knowledge-base` | `{…}`            | Add to it.                                                      |
| `poll-agent-result`     | `{"jobId":"…"}`  | Collect a deferred long-running result.                         |

`tools/list` is the source of truth for what this grant can actually do. If it returns
only four tools, the connection was made read-only: BlueNexus filters the list by scope,
so `write-connections` and `add-to-knowledge-base` are genuinely absent rather than merely
refused. In that case say the connection is read-only and the user can re-grant with write
access on the Keychain page — do not keep retrying the missing tool.

## Describe the goal, not the API

`read-connections` and `write-connections` do not take an endpoint or a method. They take
an instruction in plain words, and a BlueNexus agent picks the tools on the other side —
GitHub alone exposes 88, Notion 40. So write:

```json
{ "prompt": "Summarise the unread Slack DMs I got this week" }
```

not a description of Slack's API. Naming a specific service, account, or time window
helps it choose well. Asking for something enormous ("audit every message in every
channel") makes it exhaust its reasoning budget and return an apology — split those up.

Run `list-connections` first when you are not sure a service is actually connected.
Assuming it is and getting a confusing answer wastes a turn.

## Long-running tasks

A call that runs past about 50 seconds does not hang or fail. It returns text like:

```
Still working on your request. Call the `poll-agent-result` tool with jobId="…"
```

That is a normal outcome, not an error. Take the `jobId`, wait a little, then call
`poll-agent-result` with it. Broad reads and multi-step writes routinely go this way.

## Care

- `write-connections` acts on the user's real accounts — it sends messages, creates
  issues, publishes posts. Confirm intent before calling it, and say plainly what you are
  about to do. `read-connections` is safe to use freely.
- Rate limit is 30 requests per minute. Back off on `429` rather than retrying hard.
- Agent runs consume the user's credits; a failure mentioning credits means their balance
  is out, not that you called it wrong.
- On `401`, the token has expired and core will refresh it on the next turn — say so
  rather than trying to re-authenticate. You cannot log in from here.
