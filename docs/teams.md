# Microsoft Teams

QM answers in Microsoft Teams through the same generic chat core that serves partner chat hosts. Teams
activities arrive at `POST <public-url>/v1/surfaces/teams/activities`, are checked against the Bot Framework
token service, and become generic chat events, so DMs, group chats, channel threads, approval cards and
reactions follow the same turn lifecycle as every other chat surface.

Each organization brings its own bot. The bot is a single-tenant app registration in the organization's own
Microsoft Entra tenant, and its credentials live in that QM workspace's settings, never in deployment
environment variables.

## 1. Register the bot

In the [Teams Developer Portal](https://dev.teams.microsoft.com/tools/bots), sign in as an admin of the
organization's tenant, open **Tools → Bot management** and create a bot. Then:

- **Configure:** choose **HTTPS endpoint** and enter `<public-url>/v1/surfaces/teams/activities`.
- **Client secrets:** create one and keep it; it is shown once.
- **Channels:** keep **Microsoft Teams** enabled.

An Azure Bot resource also works. Create it as **Single Tenant**; new multi-tenant bots can no longer be
created.

## 2. Bind the bot to the workspace

Store the organization's Entra tenant ID, the bot's app ID and its secret on the QM workspace:

```bash
qm tenant settings set <workspace> teams '{"tenantId":"<entra-tenant-id>","appId":"<bot-app-id>","appSecret":"<client-secret>"}'
```

One Entra tenant binds to one workspace. Activities from any other tenant, or signed for any other bot, are
refused.

## 3. Install the app with access to every message

Teams only delivers @mentions in group chats and channels unless the app holds resource-specific consent.
QM decides on its own when to join a conversation, so the app manifest asks for every message in the teams
and chats it is installed in. Create the app in the Developer Portal (**Apps → New app**), add the bot under
**App features → Bot** with the **Personal**, **Team** and **Group chat** scopes, and make sure the manifest
carries:

```json
{
  "manifestVersion": "1.25",
  "supportsChannelFeatures": "tier1",
  "webApplicationInfo": { "id": "<bot-app-id>", "resource": "https://RscBasedStoreApp" },
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "ChannelMessage.Read.Group", "type": "Application" },
        { "name": "ChatMessage.Read.Chat", "type": "Application" }
      ]
    }
  }
}
```

The Teams admin center refuses a team-scoped app without `supportsChannelFeatures`, which needs manifest 1.25
or later. Download the app package and upload it to the organization's app catalog (Teams admin center → **Manage
apps → Upload new app**, or **Apps → Manage your apps → Upload an app → Upload an app to your org's app
catalog** in Teams). The person who adds it to a team or chat grants the consent.

## 4. Sign in with Microsoft

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
```

Leave `PORTAL_EXPECTED_TEAM_ID` unset; the tenant-specific issuer already pins the organization.

## Identity

A Teams person is the email or user principal name on their Teams account. People in the bound tenant count
as members of the workspace unless QM has them deactivated; B2B guests and people from other tenants get the
external guest treatment that generic chat gives any unvouched participant.

## Current limits

- Files are not exchanged yet; messages and cards are text only.
- Replies arrive as whole messages; Teams streaming (1:1 chats only) is not used yet.
- Reactions are limited to the ones Teams documents: 👍 ❤️ 😆 😮 😢 😡 👀 ✅ 👋 📌 🚀.
- Bots cannot post in private channels.
- Only the commercial Microsoft cloud is supported.
