# Microsoft Teams

QM answers in Microsoft Teams through the same generic chat core that serves partner chat hosts. Teams
activities arrive at `POST <public-url>/v1/surfaces/teams/activities`, are checked against the Bot Framework
token service, and become generic chat events, so DMs, group chats, channel threads, approval cards and
reactions follow the same turn lifecycle as every other chat surface.

Each organization brings its own bot. The bot is a single-tenant app registration in the organization's own
Microsoft Entra tenant, and its credentials live in that QM workspace's settings, never in deployment
environment variables.

## Connect a workspace

An org admin connects Teams from **Settings → Microsoft Teams** (also linked from **Settings → Onboarding**).
The page walks through each step with this deployment's own values to copy:

1. Create a bot in the [Teams Developer Portal](https://dev.teams.microsoft.com/tools/bots), point its HTTPS
   endpoint at `<public-url>/v1/surfaces/teams/activities`, and create a client secret. An Azure Bot resource
   created as **Single Tenant** works too; new multi-tenant bots can no longer be created.
2. Find the organization's directory (tenant) ID in Microsoft Entra.
3. Paste the tenant ID, bot ID and secret and choose **Verify and connect**. QM asks Microsoft for a bot token
   with them before saving, and shows Microsoft's reason when it refuses. One Entra tenant binds to one
   workspace; activities from any other tenant, or signed for any other bot, are refused.
4. Download the generated Teams app and upload it in the Teams admin center (**Manage apps → Upload new app**).
   The package carries the bot, the workspace's branding, `supportsChannelFeatures: "tier1"` (manifest 1.25),
   and the resource-specific consent that lets the bot hear every message in the teams and chats it joins:
   `ChannelMessage.Read.Group` and `ChatMessage.Read.Chat`. Download and upload again after changing the bot.
5. Add the app in Teams, message it, and mention it in a channel.

The operator CLI can bind a workspace too:

```bash
qm tenant settings set <workspace> teams '{"tenantId":"<entra-tenant-id>","appId":"<bot-app-id>","appSecret":"<client-secret>"}'
```

## Sign in with Microsoft

A Teams organization signs in to QM's web app with Microsoft instead of Slack. Reuse the bot's app
registration as the sign-in client, in the Entra admin center under **App registrations**:

- **Authentication:** add a **Web** platform with the redirect URI `<public-url>/auth/callback`.
- **Token configuration:** add the optional ID token claims `email` and `xms_edov`. QM only trusts an email
  address that Microsoft reports as owned by a verified domain.

Then point the portal at the tenant's Microsoft identity platform endpoints:

```bash
OIDC_ISSUER=https://login.microsoftonline.com/<entra-tenant-id>/v2.0
OIDC_AUTH_ENDPOINT=https://login.microsoftonline.com/<entra-tenant-id>/oauth2/v2.0/authorize
OIDC_TOKEN_ENDPOINT=https://login.microsoftonline.com/<entra-tenant-id>/oauth2/v2.0/token
OIDC_USERINFO_ENDPOINT=https://graph.microsoft.com/oidc/userinfo
OIDC_JWKS_URI=https://login.microsoftonline.com/<entra-tenant-id>/discovery/v2.0/keys
OIDC_SCOPES="openid profile email"
OIDC_CLIENT_ID=<bot-app-id>
OIDC_CLIENT_SECRET=<client-secret>
OIDC_PRINCIPAL_CLAIM=email
OIDC_ALLOWED_EMAIL_DOMAIN=<the organization's email domain>
```

The tenant-specific issuer only accepts work accounts from that Entra directory, so personal Microsoft
accounts and other organizations never reach QM. `OIDC_ALLOWED_EMAIL_DOMAIN` then refuses any account, B2B
guests included, whose verified email is outside the organization's domain. Leave `PORTAL_EXPECTED_TEAM_ID`
unset; it is a Slack concept. Grant consent for the organization the first time an admin signs in so
employees are not asked individually.

## Outlook mail and OneDrive at sign-in

The `microsoft` connector gives the agent the signed-in person's Outlook mail and OneDrive through Microsoft
Graph (the `microsoft-365` skill). Reuse the same app registration:

- **API permissions:** add the Microsoft Graph delegated permissions `offline_access`, `User.Read`,
  `Mail.ReadWrite`, `Mail.Send` and `Files.ReadWrite.All`, then **Grant admin consent** for the organization.
- **Authentication:** add the Web redirect URI `<public-url>/v1/connectors/oauth/microsoft/callback`.
- Set `MICROSOFT_OAUTH_CLIENT_ID` and `MICROSOFT_OAUTH_CLIENT_SECRET` on core (or enter the client on the
  Connectors admin page).

When someone signs in with Microsoft and has not connected Microsoft 365 yet, the portal sends them through
the connector once on the way in. With admin consent granted there is no prompt, so they arrive connected.
Like every personal connector, the token reaches the agent only in that person's own DMs and web chats.

## Identity

A Teams person is the email or user principal name on their Teams account. People in the bound tenant count
as members of the workspace unless QM has them deactivated; B2B guests and people from other tenants get the
external guest treatment that generic chat gives any unvouched participant.

## Current limits

- Files are not exchanged yet: the Teams host declares no file support, so the agent is told it can't attach files here and pastes content instead, and files people attach in Teams don't reach it.
- Teams refuses a message over about 28 KB, so a longer reply is split into several messages of at most 9,000 characters (under the limit even when every character takes three bytes); an edit is clipped to that length.
- Replies arrive as whole messages; Teams streaming (1:1 chats only) is not used yet.
- Reactions are limited to the ones Teams documents: 👍 ❤️ 😆 😮 😢 😡 👀 ✅ 👋 📌 🚀.
- Bots cannot post in private channels.
- Only the commercial Microsoft cloud is supported.
