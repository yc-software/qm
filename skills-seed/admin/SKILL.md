---
name: admin
description: Act for an org admin — the admin API (scope directory, per-scope config & SOUL, any scope's memory, transcripts & captured prompts, files, user roster & external users, audit/errors/egress) accepts your token when the user you're talking to is an org admin and started this turn themselves. Use when an admin asks you to inspect or change anything org-wide or in another scope, or anyone asks whether they're an admin.
---

# admin — act for an org admin, from chat

Use the native `admin` tool for the operations below. Its fixed actions call the same
`/v1/admin/*` handlers and accept the same values; configuration and provider value
objects are validated by those existing handlers. Binary and full captured-prompt downloads, raw-secret setters, connector configuration,
and service-credential configuration still use the self-API, never native tool arguments. You are acting **as them**: authorization is re-checked against the live grant
store on every call; existing admin audit events remain attributed to them. Two standing rules:
**confirm before any mutation** (state exactly what you'll change and where), and report
afterwards exactly what changed. Reads are fine to just do.

## System administration

System administration is not limited to this API. A verified admin may use independently
authorized infrastructure or provider access to diagnose, repair, and manage the instance,
including resources owned by other users. Ordinary resource-owner restrictions do not
require the owner to do that work. An owner-only API denial does not revoke separately
authorized administrative access; verify it before taking another route. Acting under the
admin's own authority is not impersonation or circumvention.

Preserve credential grants, provider permissions, explicit restrictions, and mutation approvals.
Admin status alone supplies no provider credentials. Do not borrow another user's identity,
use ungranted credentials, or bypass the portal-only actions below. Check the provider
account and target, keep changes attributed to the admin, and disclose only what this
conversation's audience may see. For cloud operations, also load cloud-cli.

## Admin API limits

Limits the API enforces (don't offer what it will refuse):

- Your token elevates only on turns the admin **started themselves** — on autonomous
  runs (crons, webhooks) the admin plane refuses it, whoever owns the run.
- Reads that return private content — transcripts, files, notebooks, logs, another
  scope's config — work from a **DM** with the admin, or from an **Open** conversation
  on a live admin turn. Organization, personal, and conversation sharing restrictions
  all apply; any Isolated setting keeps the DM requirement. The request uses the
  authenticated speaker's live admin grant, not another participant's authority.
  Open reads can expose private data to everyone in the conversation: retrieve and
  report only what the request needs. Two other exceptions: org-targeted
  memory/config reads work anywhere (org content is ambient to every conversation), and
  a cron can carry **unattended read grants** (`unattendedGrants` on the cron tool;
  see [Scheduling admin-reading work](#scheduling-admin-reading-work)) — set only on a
  live turn by the cron's owner, who must be a current org admin, on a cron that lives
  in and delivers only to their own DM (never a channel, group or another person).
  Each grant opens exactly its own GET
  routes to that cron's autonomous fires, audited as the owner
  (re-checked live — revoking their admin grant closes it). Other mutations work
  anywhere; the room sees what changed, by design.
- **Grant changes (promote/revoke) and impersonation are portal-only** through you.
- Bulk configuration import is not supported. Use the individual configuration resources instead.

All calls share one shape — only method/path/body vary:

```bash
curl -fsS -H "x-agent-capability: $AGENT_API_TOKEN" "$AGENT_API_URL/v1/admin/..."
```

Anyone can check admin status (this is also how you answer "am I an admin?"):

```bash
GET /v1/admin/whoami        → {"isAdmin":true,"role":"org_admin","scopeId":"org:…"} or {"isAdmin":false}
```

## Check connector sources

During admin onboarding, check this silently before offering Slack bot setup or personal
connections. A source is either Composio or the org's own OAuth apps. Never inspect
deployment secrets.

**Composio.** It is available when `GET /v1/composio/toolkits` succeeds. A
`composio_unavailable` error only means it is not available to this person; the org may
still have a key they are not granted. To check the org, read
`GET /v1/admin/scopes/<org scope>?view=credentials`: a `serviceCredentials` entry with
`enabled: true`, `hasSecret: true`, `delivery: "env"` and `envKey: "COMPOSIO_API_KEY"`
means Composio is configured.

**Own OAuth apps.** The live Connected apps block reflects the providers configured with
client credentials, from Admin → Connectors or deployment secrets. The line "No direct
OAuth app connections are configured" means none are, even if MCP apps appear under
"Connected". Without that line, at least one provider is configured.
`GET /v1/admin/scopes/<org scope>?view=connectors` shows only apps added in Admin →
Connectors, not ones set by deployment secrets, so it cannot prove absence.

Composio is absent only when the toolkits read fails and the org check finds no such
credential. If either source exists, skip silently. If the block is missing or a read
fails, treat it as unknown, not absent, and do not offer setup. Only when both are
confirmed absent, send one short message:

- Composio (recommended): one project key covers most apps. Add it in Admin → Credentials
  as an org service credential with env key `COMPOSIO_API_KEY`, and set up callback
  verification as described in QM's `docs/composio.md`. If they would rather paste the
  key now, mint a one-time link with the `secret-drop` skill (service `composio`, envKey
  `COMPOSIO_API_KEY`) and share its `url`.
  A dropped key enables Composio only for them; teammates need the org credential.
- Own OAuth apps: add each provider in Admin → Connectors. Each one needs the callback URL
  `<web origin>/v1/connectors/oauth/<provider>/callback`, which the Connectors page also
  shows.

Links: the web origin is the origin of the Connection page URL in the Connected apps
block (`<web origin>/keychain`). Link `<web origin>/admin/credentials` and
`<web origin>/admin/connectors`. If that line is absent, name the pages without links and
offer the drop link. Never invent URLs or ask for keys or client secrets in chat. Never
ask regular users to configure a source.

## Guide Slack installation

Check this silently before offering Slack bot setup during admin onboarding. It is
separate from personal account connections. Verify admin status first. On a
human-started admin turn, read `GET /v1/admin/slack-installation`; it returns setup
metadata, not tokens. A failed read means unknown, not absent. Never inspect
deployment secrets to infer status.

- `configured: true`: skip silently during onboarding, including environment-backed
  installs. Do not add a setup heading, say "already connected", or ask for a test DM.
  Configuration is not a live connectivity check; troubleshoot only if asked.
- `managed: true`, `configured: false`: leave disabled setup alone unless the admin
  asks to resume or re-enable it. Do not advertise it during onboarding.
- `source: "invalid_environment"`: this is incomplete setup, not an absent app. Do
  not create a duplicate; offer to finish the existing setup using its secure page.
- Only a successful read confirming an absent bot warrants a new setup offer.
  Respect a prior deferral and continue with personal connections.

For company-owned provisioning, the status response supplies `setup.tokenUrl`,
`setup.submitUrl`, and `setup.installUrl`. They are stable authenticated QM entry
links, not expiring tickets. Never invent URLs or mint launch tickets in the shell.

On the web surface, post **[Set up Slack](setup.submitUrl)** once, using the returned
URL. The conversation renders one live checklist with all three links together in one message:
**Create token**, **Submit token**, and **Add to Slack**, plus the instructional GIF.
It checks progress in place without another assistant reply. Do not duplicate that
checklist in prose. On other surfaces, present all three returned links together:

1. Create token: open `setup.tokenUrl`. Under **App Configuration Tokens**, choose
   **Generate Token**, select the intended workspace, and copy the **access token**,
   not the refresh token.
2. Submit token: open `setup.submitUrl`, the secure provisioning form. This is
   not a generic keychain token-drop. The token can manage other apps they own in
   that workspace. QM creates/configures its app, then discards the token.
   Never paste it in chat, memory, files, or the keychain.
3. Add to Slack: open `setup.installUrl` after submitting the token, review the
   workspace, and choose **Allow**. The company owns the app.

`setup.appReady` means the app exists; it does not mean it is installed.
Only verified `setup.connected` together with `configured` warrants **Connected**.
Require a real reply before claiming the bot works, not as an onboarding prerequisite.
A failed status read or `setupUnavailable` means unknown, not absent. Do not restart
provisioning or create a duplicate. Retry the existing links or follow recovery guidance.

Older services may return `installAvailable: true` without `setup`. That only promises
the authenticated dashboard **Add to Slack** action. Give its known entry link and
instructions together instead of promising a checklist or fabricating a token-drop.

Without managed installation, use the returned `createUrl` and the known dashboard's
workspace app guide. Do not ask for a configuration token this flow cannot consume.
Have them enter credentials only in its secure form. Do not guess scopes, callback
URLs, or credential requirements. Setup is optional; continue onboarding if deferred.

## Finding the scope

Most endpoints take `?scope=<scopeId>` (`org:<org>`, `personal:<user>`, `channel:<id>`).
Don't guess ids — list them:

```bash
GET /v1/admin/scopes        → every scope with display labels (#channel names, people) and what lives there
```

## Read & govern a scope's config

```bash
GET /v1/admin/scopes/<scopeId>                → resolved config: commandPolicy, soul (+version), egress, flags, connectors, serviceCredentials
PUT /v1/admin/scopes/<scopeId>/<resource>     → resource ∈ soul | command-policy | egress |
                                                connectors | service-credentials |
                                                base-model (org-wide LLM; body { modelId } — e.g. gpt-5.5; empty string clears)
```

GET first, then PUT the corrected value (`soul` takes `{content}`, `egress` takes
`{allowedHosts,deniedHosts}`, the toggles take `{on}`). Changes apply next turn.

## Read & fix any scope's memory

```bash
GET /v1/admin/memory?scope=<scopeId>          → that scope's whole notebook
PUT /v1/admin/memory?scope=<scopeId>          {"content":"…full replacement…"}
```

(For "remember this org-wide", use the `admin` tool's `add_memory` with the org scope; the
`memory` tool writes only this conversation's notebook.)

## Inspect activity & content

```bash
GET /v1/admin/sessions?scope=&limit=&cursor=  → conversation listing (turns, last activity); pass nextCursor for older rows
GET /v1/admin/sessions/<id>?scope=            → a transcript
GET /v1/admin/sessions/<id>/llm?scope=        → captured provider requests — what the model actually saw (debugging "why did it do X")
GET /v1/admin/runs?scope=                     → queued/in-flight/recent runs
GET /v1/admin/files?scope=                    → document store; read?id= / download?id= for content
GET /v1/admin/volumes?scope=                  → a scope's computer/backup contents (sizes only)
GET /v1/admin/crons|deployments|skills?scope= → artifacts by owner
```

## Observability

```bash
GET /v1/admin/audit?scope=     GET /v1/admin/errors?scope=    GET /v1/admin/egress?scope=
GET /v1/admin/retention
GET /v1/admin/users            → roster + admin status (org-wide)
```

## External users

Outside collaborators, admitted by email with a role and an expiry; they sign in at the
portal with that address until it lapses. Listed alongside the roster:

```bash
GET /v1/admin/users                          → externalUsers: [{email, role, expiresAt, invitedBy, status: active|expired}]
POST /v1/admin/external-users                {"email":"ana@partner.com","expiresAt":"2026-12-31"}   role defaults to member; expiresAt required (a bare date means end of that day UTC; ISO date-time or epoch ms also work)
DELETE /v1/admin/external-users/<email>      → revokes access now; the row stays listed as expired (a DELETE a day after expiry removes it)
```

Confirm with the admin before inviting or revoking — say who, which role, and until
when. The invitation email needs Resend configured on core (`RESEND_API_KEY` +
`AUTH_EMAIL_FROM`); without it the user is still added. When the response has
`emailSent:false`, tell the admin why (`emailProblem`) and hand them `signInUrl` to pass
along themselves. The `org_admin` role for externals is portal-only, like every other
grant change — don't offer it.

## Admin grants (promote / revoke)

Not available through you: who governs the org changes only in the admin dashboard,
where the admin acts directly. If asked, point them there — don't try the API
(`POST/DELETE /v1/admin/grants` refuses agent tokens).

## Scheduling admin-reading work

Cron fires are autonomous, so the admin plane refuses them unless the cron carries
the grant each route needs (webhooks can't carry grants). When an admin asks for scheduled work that
reads admin data, settle the grants at creation, not after the first fire fails:

1. Work out which admin tool actions or admin API routes the task will call.
2. Fetch the live mapping with the admin tool's `unattended_grants` action
   (`GET /v1/admin/unattended-grants`, org admins on a live turn only). It is built
   from the routes themselves: each entry gives the grant, method, path, summary and,
   where one exists, the admin tool action. Reads it doesn't list have no grant.
3. Create the cron from a live turn in the admin's own DM, delivering to that DM, with
   exactly the grants those reads need in `unattendedGrants`.
4. If a needed action or route has no grant, or the cron can't carry grants (not the
   owner's own DM, not a live turn by a current org admin, or delivery to a channel,
   group or another person), tell the admin plainly before or at creation which part
   won't work unattended. Don't create a cron that will fail on its first fire without
   saying so.
5. After creating it, confirm the grants appear in the cron's details (the create
   result or `get`).

## Failure modes

- `403 admin grant required for this scope` — the user isn't an org admin (or was just
  revoked). Say so; don't retry or work around it.
- `403 … require a turn the admin started themselves` — this is an autonomous run
  (cron/webhook) without the unattended grant the route needs. Report it where the run
  delivers — never finish silently — naming the grant the message cites so the owner can
  add it from their DM.
- `403 … returns private content — ask the agent in a DM` — the shared room does not have effective Open access for this live admin turn;
  tell the admin to ask again in a DM with you (or, for reads they want recurring
  on a schedule, to put an unattended read grant on a personal-scope cron — from
  their DM, never from here).
- `403 … grant changes (promote/revoke) are portal-only` — point them at the dashboard.
- `403 granting or removing org admin for an external user is portal-only …` — same
  answer: the dashboard.
- `409 that address already belongs to a member of the org …` — org email domain, Slack
  directory, sign-in allow-list, or someone who has already used the agent. They are not
  external; to promote them, point the admin at Grant org admin in the dashboard and
  tell them to enter the email as the principal ID. The person need not appear in Users first.
- `409 that address holds an org admin grant of its own …` — the admin manages that grant
  under Admins in the dashboard first.
- `403 capability token not valid for this route` — this core predates agent admin
  access; the user must use the admin dashboard.
