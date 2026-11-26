---
name: connect-apps
description: Link a user's Slack account or add QM to the company Slack, or connect an administrator-enabled SaaS app with a one-time OAuth consent link.
---

## Connecting SaaS apps

Check Composio availability through `GET /v1/composio/toolkits` on the authenticated QM API. When available, load the `composio` skill and use its discovery and consent flow instead
of the direct OAuth flow below. An empty direct OAuth list or a native
`oauth_not_configured` error does not describe Composio availability. Preserve explicit
app restrictions and account permissions; never switch credentials to evade a denial.

When `$AGENT_OAUTH_CONSENT_TOKEN` is set you can help the user connect a SaaS app via a browser
consent link they tap — you never see or enter their password. The direct OAuth allowlist is
the providers configured by the admin, the catalog entries with `configured: true`:

```sh
curl -fsS "$AGENT_API_URL/v1/connectors/catalog" -H "x-agent-capability: $AGENT_API_TOKEN" \
  | jq -r '.catalog[] | select(.configured) | .provider'
```

Offer direct OAuth links only for those providers, and none when the list is empty. Mint a single-use link for the selected provider, then give the user the full URL to open:
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

## Connect a personal Slack account

When someone asks to connect Slack or use their existing web connectors from Slack, offer the personal Slack linking widget in web chat, or direct them to QM web Settings (`/?view=settings`) and **Link your Slack account** from Slack. They must sign in with their existing web account before connecting. This authorizes personal Slack access and links their verified Slack identity to that QM account. Workspace bot installation is separate. Do not create a generic Composio Slack link or infer identity from matching emails.

In web chat, when someone asks to link or connect their Slack, reply with one short line and `::link-slack-account{}` as a standalone paragraph, outside code fences and quotations. Do not list other options. It shows the personal linking card and its verified connection status. Company bot installation must be completed first: for an admin whose `GET /v1/admin/slack-installation` shows `configured: false`, use `::add-to-slack{}` instead. When they ask to add or install QM in their Slack, reply with `::add-to-slack{}`. That widget shows whether QM is already installed and includes the linking card, so never pair it with `::link-slack-account{}`, and do not describe buttons or name a workspace around it. Outside web chat, send them to QM web Settings while signed into their existing web account; web widget directives render only in web chat.

## Dedicated Slack apps for personas

Org admins and persona owners can give any persona its own Slack app (bot user, avatar, DM thread, and @handle) via HTTP Events and Slack's App Manifest API. This works on **any Slack plan** (Free, Pro, Business+, or Enterprise Grid; Enterprise Grid is only needed if passing `orgDeploy: true`).

### First-time setup: Slack App Configuration Token

Creating persona Slack apps in one click requires a workspace **App Configuration Token** (saved once per org, encrypted, and auto-rotated every 12 hours via `tooling.tokens.rotate`).

- Check if one is saved: `GET /v1/personas/:id/slack` (`hasOrgConfigToken`) or (org admins) `GET /v1/admin/slack-config-token`.
- **Where the user can find it:** open `https://api.slack.com/apps`, scroll to the bottom section **Your App Configuration Tokens**, click **Generate Token**, pick their Slack workspace, and copy the **Refresh Token** (`xoxe-1-…`, preferred so QM auto-rotates it) or **Access Token** (`xoxe.xoxp-…`).
- **Getting it with a live browser:** if the user asks QM to set it up and a browser (`browse` skill) is available, open `https://api.slack.com/apps` in the user's browser profile (routing any Slack sign-in wall through the live view), scroll to **Your App Configuration Tokens → Generate Token**, select the workspace, capture the Refresh Token (`xoxe-1-…`) and Access Token (`xoxe.xoxp-…`) without printing them in chat, and save them immediately via `PUT /v1/admin/slack-config-token` with `{"refreshToken":"…","accessToken":"…"}`.
- **Without a config token (manual fallback):** `GET /v1/personas/:id/slack` also returns `manifestCreateUrl` (pre-filled Slack app manifest link). The user can create/install the app in Slack and attach it with `PUT /v1/personas/:id/slack` (`{"botToken":"xoxb-…","signingSecret":"…"}`).

### Creating and installing a persona's Slack app

1. Call `POST /v1/personas/:id/slack/create` (empty body `{}` uses the saved org config token, or pass `{"refreshToken":"…"}` / `{"configToken":"…"}` for a one-off token; add `"orgDeploy":true` only for Enterprise Grid org-wide apps).
2. The response returns `oauthAuthorizeUrl` (`status: "pending_install"`). Give the user that exact link — one click on **Allow** in Slack completes OAuth, saves the bot token, and starts the persona's Slack bot automatically.
3. To remove it later, call `DELETE /v1/personas/:id/slack` (pass `{"deleteRemote":true}` to also delete the app in Slack).
