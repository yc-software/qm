---
name: admin
description: Act for an org admin — the admin API (scope directory, per-scope config & SOUL, any scope's memory, transcripts & captured prompts, files, user roster & external users, audit/errors/metrics/egress) accepts your token when the user you're talking to is an org admin and started this turn themselves. Use when an admin asks you to inspect or change anything org-wide or in another scope, or anyone asks whether they're an admin.
---

# admin — act for an org admin, from chat

A connector skill: no new tool. When the chatting user is an org admin (your system
prompt says so — "Acting for an org admin"), the `/v1/admin/*` endpoints accept your
token. You are acting **as them**: authorization is re-checked against the live grant
store on every call, and every call is audited under their name. Two standing rules:
**confirm before any mutation** (state exactly what you'll change and where), and report
afterwards exactly what changed. Reads are fine to just do.

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
  a cron can carry **unattended read grants** (`unattendedGrants` on the cron:
  `admin.sessions.read`, `admin.audit.read`, `admin.metrics.read`, `admin.egress.read`,
  `admin.files.read`) — set only on a live turn by the cron's owner, who must be a
  current org admin, on a personal-scope cron running as its owner. Each grant opens
  exactly its own GET routes to that cron's autonomous fires, audited as the owner
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

## Maintain the instance

On a verified live admin request, take responsibility for keeping the instance working.
Ordinary resource ownership and conversation membership do not limit administration.
Existing resource tools and API routes honor live admin authority from the admin's DM
or an effectively Open conversation. Use them directly; do not send an admin to the
affected user's conversation or require that user to repeat the request.
Act and audit as the administrator, not as the resource owner. Personal credentials and
external-service permissions remain separate from administration of QM resources.

Use the normal operation, not an invented `/v1/admin/` variant:

- **Crons:** `cron get/patch/disable` for another owner's task, schedule, runtime or pause.
- **Webhooks:** `webhook list/disable`; the catalog also lists enable and event-history routes.
- **Loops:** use the existing `/v1/loops` routes to inspect, repair or pause automation. Repair authority does not substitute for approval of external sends or shipping grants.
- **Apps:** `apps publish/share/move` with the existing app's name or ID as supported by that operation. Updating an app preserves its owner; moving explicitly transfers it.
- **Files:** `files share` with the artifact ID and destination, or `POST /v1/share` with `{type:"file",id,toScope,permission}`.
- **Skills:** `PUT /v1/skills/:id` with `{body,description?}` edits the existing skill; `skills share/move` changes access or home.
- **Memory, guidance and scope runtime:** use the administrative resources below.

Discover exact methods and fields with `GET /v1/apis`; filter its output to the resource
being repaired. Skill edits are **not** `PUT /v1/admin/skills/:id`, and file sharing is
**not** `/v1/admin/files/:id/share`. Read back the saved resource after changing it.
For app source recovery, use `/v1/deployments/:id/git` with the live capability header:
`git -c http.extraHeader="x-agent-capability: $AGENT_API_TOKEN" clone "$AGENT_API_URL/v1/deployments/<id>/git"`.
Pass the header again for fetch/push; never save it in Git config or the remote URL.

Ownership does not grant access to another person's credentials. Changing a cron's
execution identity or unattended grants remains subject to its separate consent checks.

```bash
GET /v1/admin/sandboxes/<scopeId>
POST /v1/admin/sandboxes/<scopeId>  {"action":"create","backend":"<provider>","name":"<name>"}
POST /v1/admin/sandboxes/<scopeId>  {"action":"default","sandboxId":"<id>"}
POST /v1/admin/sandboxes/<scopeId>  {"action":"retire","sandboxId":"<id>"}
```

Inventory includes all authorized computers plus the named scope's default. Select the
intended computer by `ownerScopeId` and ID. Use the ordinary sandbox tool with its
`sandbox_id` for status, restart or execution from the admin's DM or an Open conversation.
Creation is blank; default selection changes routing, not ownership or file contents.
Do not copy the current conversation's credentials to another scope's computer.

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

(For "remember this org-wide" you don't need the admin plane at all — `"scope":"org"`
on the memory self-API is the lighter path; see the memory skill.)

## Inspect activity & content

```bash
GET /v1/admin/sessions?scope=&limit=&offset=  → conversation listing (turns, last activity)
GET /v1/admin/sessions/<id>?scope=            → a transcript
GET /v1/admin/sessions/<id>/llm?scope=        → captured provider requests — what the model actually saw (debugging "why did it do X")
GET /v1/admin/runs?scope=                     → queued/in-flight/recent runs
GET /v1/admin/files?scope=                    → document store; read?id= / download?id= for content
GET /v1/admin/volumes?scope=                  → a scope's computer/backup contents (sizes only)
GET /v1/admin/crons|deployments|skills?scope= → artifacts by owner
```

## Observability

```bash
GET /v1/admin/audit?scope=     GET /v1/admin/errors?scope=    GET /v1/admin/metrics?scope=
GET /v1/admin/egress?scope=    GET /v1/admin/retention
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

## Failure modes

- `403 admin grant required for this scope` — the user isn't an org admin (or was just
  revoked). Say so; don't retry or work around it.
- `403 … require a turn the admin started themselves` — this is an autonomous run
  (cron/webhook); admin actions only ride turns the admin personally initiated. Say so.
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
