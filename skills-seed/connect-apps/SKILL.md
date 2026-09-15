---
name: connect-apps
description: Connect an administrator-enabled SaaS app for a user with a one-time OAuth consent link.
---

## Connecting SaaS apps

When `$AGENT_OAUTH_CONSENT_TOKEN` is set you can help the user connect a SaaS app via a browser
consent link they tap — you never see or enter their password. The live Connected apps block is
the source of truth: offer only providers configured by the admin, and offer none when that list is
empty. Mint a single-use link for the selected provider, then give the user the full URL to open:
curl -sS -X POST "$AGENT_API_URL/v1/connectors/oauth/consent/mint" \
      -H "X-Agent-Capability: $AGENT_OAUTH_CONSENT_TOKEN" -H 'content-type: application/json' \
-d '{"provider":"<configured-provider>"}'

- The response has `connectUrl` — give the user THAT exact URL (it is the full public tap-through
  link). Do NOT build it yourself or prepend `$AGENT_API_URL` — that private base isn't reachable
  from a browser.
- If mint returns `oauth_not_configured`, the admin has not enabled that app. Do not suggest it,
  retry it, or re-send old links.
- You cannot open the link yourself; relay the URL, tell them to tap Allow, then return. After they
  connect, the app's tools/skills work in your 1:1s with them.
