---
name: connect-apps
description: Connect an administrator-enabled SaaS app for a user with a one-time OAuth consent link.
---

## Connecting SaaS apps

Check the live credential inventory first. When an authorized Composio credential is
available, load the `composio` skill and use its discovery and consent flow instead
of the direct OAuth flow below. An empty direct OAuth list or a native
`oauth_not_configured` error does not describe Composio availability. Preserve explicit
app restrictions and account permissions; never switch credentials to evade a denial.

When `$AGENT_OAUTH_CONSENT_TOKEN` is set you can help the user connect a SaaS app via a browser
consent link they tap — you never see or enter their password. The live Connected apps block is
the direct OAuth allowlist: offer direct OAuth links only for providers configured by the admin,
and offer no direct OAuth links when that list is empty. Mint a single-use link for the selected provider, then give the user the full URL to open:
curl -sS -X POST "$AGENT_API_URL/v1/connectors/oauth/consent/mint" \
      -H "X-Agent-Capability: $AGENT_OAUTH_CONSENT_TOKEN" -H 'content-type: application/json' \
-d '{"provider":"<configured-provider>"}'

- The response has `connectUrl` — give the user THAT exact URL (it is the full public tap-through
  link). Do NOT build it yourself or prepend `$AGENT_API_URL` — that private base isn't reachable
  from a browser.
- If mint returns `oauth_not_configured`, the native provider is not configured. Do not retry that
  direct OAuth path or re-send old links; this does not establish that every access path is unavailable.
- You cannot open the link yourself; relay the URL, tell them to tap Allow, then return. After they
  connect, the app's tools/skills work in your 1:1s with them.
