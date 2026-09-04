# Slack apps

Slack does two independent jobs for a deployment, and each is its own Slack app.
Create only what the operator asked for.

| App      | Job                                                          | Enabled by                     |
| -------- | ------------------------------------------------------------ | ------------------------------ |
| `qm`     | the agent in channels, DMs, and group messages               | `"slack"` in `services`        |
| `qm SSO` | signs people in to the web surfaces with their Slack account | Slack OIDC instead of `"auth"` |

A workspace can have one without the other: the bot alongside email sign-in, or
Slack sign-in with no bot.

## The bot app

QM uses one private Socket Mode app per deployment and workspace.

Run `npm exec qm -- outputs` and open the exact bot manifest creation URL.
Install the app, create an app-level token with `connections:write`, and enter
the bot and app tokens in the Admin Slack card. The Admin surface validates and
stores them without provider credentials.

Invite the bot to the chosen channel, mention it, and require a reply. Return:

```text
Bot dashboard: https://api.slack.com/apps/<bot-app-id>
Test channel: https://app.slack.com/client/<team-id>/<channel-id>
```

## The SSO app

Slack sign-in replaces the built-in `auth` broker rather than supplementing it.
It needs no email transport, no verified sender, and no DNS work, which makes it
the shorter path for a workspace that already runs on Slack. Do not read
`references/email.md` for this route.

Drop `"auth"` from `services` and declare Slack's endpoints in `env.portal`:

```json
{
  "OIDC_AUTH_ENDPOINT": "https://slack.com/openid/connect/authorize",
  "OIDC_TOKEN_ENDPOINT": "https://slack.com/api/openid.connect.token",
  "OIDC_USERINFO_ENDPOINT": "https://slack.com/api/openid.connect.userInfo",
  "OIDC_ISSUER": "https://slack.com",
  "OIDC_JWKS_URI": "https://slack.com/openid/connect/keys",
  "PORTAL_EXPECTED_TEAM_ID": "<workspace-team-id>"
}
```

The portal already defaults to exactly these endpoints, so sign-in would work
without them — write them anyway. `qm slack render` and `qm outputs` decide a
deployment uses Slack sign-in by finding `slack.com` in `env.portal`, and
silently skip the SSO manifest and its links when the values are left implicit.

Every deployment needs one tenant trust boundary or the portal refuses to start:
`PORTAL_EXPECTED_TEAM_ID` (the workspace id, and Slack-only),
`OIDC_ALLOWED_EMAIL_DOMAIN`, or `OIDC_ALLOWED_EMAILS`. Copy the workspace id from
the Slack About dialog. `PORTAL_EXPECTED_TEAM_ID` is refused while `"auth"` is
enabled — the two sign-in paths are mutually exclusive, so switch fully.

`qm outputs` requires the `slack` service even when only the SSO app is wanted.
Keep `"slack"` in `services` and leave its bot tokens unset if the operator does
not want the agent in their workspace.

Then render and read the links:

```bash
npm exec qm -- slack render
npm exec qm -- outputs
```

`outputs` prints `qm SSO app` (the manifest creation URL), `Slack sign-in`
(`<publicUrl>/auth/login`), and `Slack SSO callback`
(`<publicUrl>/auth/callback`). Create the app from the exact creation URL — that
manifest already carries the callback, so there is no redirect URL to register by
hand. From Basic Information, put the client secret in `.env` as
`OIDC_CLIENT_SECRET` and the client id in either `env.portal.OIDC_CLIENT_ID` or
`.env`, then run `npm exec qm -- secrets push`.

Prove it before calling sign-in done: open the `Slack sign-in` URL, complete
Slack's consent screen, and land in the Web UI as the administrator. A portal
answering on `/healthz` has proved nothing about sign-in.

Keep token values, client secrets, and workspace ids out of Git, chat, and
terminal output.
