---
name: secret-drop
description: Ask a person for a credential they have not saved yet (an API key, a site login, a password) with a one-time, expiring secret-drop link. They fill it in a browser, it lands in their own keychain, and this conversation resumes with a handle to use. Use this instead of asking for secrets in chat or sending people to edit the keychain page.
---

# Secret drop: request a new credential by link

Use this when a task needs a credential nobody has saved yet. Never ask for a secret in chat,
and never tell the person to add it on the keychain page by hand.

- A teammate's credential that is already saved: use the `request-access` skill instead.
- A CLI with a device-code or browser login (gh, aws sso, gcloud): use `interactive-login`.

## Mint the link

Only on a turn a person sent. Scheduled and trigger-fired turns are refused.

```sh
curl -fsS -X POST "$AGENT_API_URL/v1/keychain/drops" \
  -H "x-agent-capability: $AGENT_API_TOKEN" -H 'content-type: application/json' \
  -d '{"service":"acme","purpose":"sign in to the Acme dashboard","fields":[{"key":"ACME_EMAIL","label":"Email","secret":false},{"key":"ACME_PASSWORD","label":"Password"}]}'
```

- `service` names the credential; `purpose` is one plain sentence the person sees on the form.
- `fields` declares the form inputs (1–8). Keys are env var names; `secret:false` shows the
  input in clear text (usernames, emails). For a single token, omit `fields` and pass
  `"envKey":"ACME_API_KEY"` instead.
- The link belongs to the person whose turn this is. If a different teammate in this
  conversation will fill it, add `"onBehalfOf":"<their id>"`.
- Send the header exactly as shown. `Authorization: Bearer` is not accepted.

The response is `{dropId, url}`. Give the person `url` exactly as returned. It carries a
link-bound token, so a rebuilt URL will not work.

## Then

- Tell them in one line what the link is for. It works once and expires.
- Stop. Don't poll.
- When they submit, the value is saved encrypted to their keychain (and, in a channel or group,
  granted to this conversation) and this conversation wakes with the new credential's handle.
  Select that handle in `execute.credentials` to get the declared env vars.
- If the link expires or they used the wrong account, mint a fresh one.
