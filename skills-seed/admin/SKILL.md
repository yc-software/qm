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

- Your token elevates on turns that carry the admin's **own authority**: a turn they
  typed, or a cron, webhook or loop fire they own (a fire runs as the person whose
  standing instructions it carries). Bot actors, external audiences and session
  messages whose authorization chain can't be verified carry none.
- Reads that return private content — transcripts, files, notebooks, logs, another
  scope's config — work from a **DM** with the admin, or from an **Open** conversation.
  Organization, personal, and conversation sharing restrictions
  all apply; any Isolated setting keeps the DM requirement. The request uses the
  authenticated speaker's admin grant, not another participant's authority.
  Open reads can expose private data to everyone in the conversation: retrieve and
  report only what the request needs. Two other exceptions: org-targeted
  memory/config reads work anywhere (org content is ambient to every conversation), and
  a cron, webhook or loop fire **carries its owner's authority** (see
  [Scheduling admin-reading work](#scheduling-admin-reading-work)): an org admin's fire
  can read on the admin plane what the admin's own typed turn could, audited as the owner
  and re-checked on every call (revoking their admin grant closes it). The audience
  rule still applies to private-content reads, so such a fire must live in the owner's
  DM or an Open conversation. Admin changes need the admin at the keyboard: a fire that
  wants one reports it where the run delivers. On a typed turn, mutations work anywhere;
  the room sees what changed, by design.
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

**Own OAuth apps.** `GET $AGENT_API_URL/v1/connectors/catalog` (header `x-agent-capability: $AGENT_API_TOKEN`) marks each provider
configured with client credentials, from Settings → Connectors or deployment secrets, with
`configured: true`. No such entry means none are.
`GET /v1/admin/scopes/<org scope>?view=connectors` shows only apps added in Settings →
Connectors, not ones set by deployment secrets, so it cannot prove absence.

Composio is absent only when the toolkits read fails and the org check finds no such
credential. If either source exists, skip silently. If a read
fails, treat it as unknown, not absent, and do not offer setup. Only when both are
confirmed absent, send one short message:

- Composio (recommended): one project key covers most apps. Add it in Settings → Credentials
  as an org service credential with env key `COMPOSIO_API_KEY`, and set up callback
  verification as described in QM's `docs/composio.md`. If they would rather paste the
  key now, mint a one-time link with the `secret-drop` skill (service `composio`, envKey
  `COMPOSIO_API_KEY`) and share its `url`.
  A dropped key enables Composio only for them; teammates need the org credential.
- Own OAuth apps: add each provider in Settings → Connectors. Each one needs the callback URL
  `<web origin>/v1/connectors/oauth/<provider>/callback`, which the Connectors page also
  shows.

Name the pages (Settings → Credentials, Settings → Connectors) without links and offer the drop
link. Never invent URLs or ask for keys or client secrets in chat. Never
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

`installAvailable: true` without `setup` means the shared QM Slack app. In web chat, reply
with one short line and `::add-to-slack{}` as its own paragraph. On other surfaces, link
**[Add to Slack](installUrl)** using the returned `installUrl`. Do not name a workspace,
mention unavailable setup, offer creating their own app, or use `createUrl`.

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

Spend caps: `PUT …/<scopeId>/spend-limit` with `{dailyUsd?, monthlyUsd?}` (USD, per UTC
day/month, counted the way the Spend page counts a scope). On the org scope it is the
default for every person's personal scope; on a person, channel or project scope it caps
that scope and overrides the default. `{}` means no cap there, `{inherit:true}` clears it.
At the cap new turns there are refused until reset, and cron fires report the refusal.

## Read & fix any scope's memory

```bash
GET /v1/admin/memory?scope=<scopeId>          → that scope's whole notebook
PUT /v1/admin/memory?scope=<scopeId>          {"content":"…full replacement…"}
```

(For "remember this org-wide" you don't need the admin plane at all — `"scope":"org"`
on the memory self-API is the lighter path; see the memory skill.)

## Inspect activity & content

```bash
GET /v1/admin/sessions?scope=&limit=&cursor=  → conversation listing (turns, last activity); pass nextCursor for older rows
GET /v1/admin/sessions/<id>?scope=            → a transcript
GET /v1/admin/sessions/<id>/llm?scope=        → captured provider requests — what the model actually saw (debugging "why did it do X")
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

Users lists the `users` table, the people and apps QM has met: someone joins on their own first
message (not a non-person actor; a Slack id is recorded as the person the directory maps it to),
when invited as a teammate, or when made an admin. Each row has a generated `userId`; `principalId`
is the person's main sign-in and `aliases` lists every sign-in that resolves to them. Linking merges
a sign-in's user into its person's. Rows carry `kind` (`person` or `app`, for Slack apps), `firstSeenAt`
and `source`; session and turn counts add up activity across all of the user's sign-ins. Any
`/v1/admin/users/<id>` route takes either the `userId` or any sign-in. Spend and Keychain people carry
`userId` too, and retention counts each person (not each sign-in) once, leaving apps out.

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

## Offboarding a user

When someone leaves, `offboard_user` (`POST /v1/admin/users/<principal>/offboard`) stops what runs as them in
one call. Run it from a DM with the admin; it reads private inventory.

1. Preview: call without `apply`. `changes` lists every step it would take, first to last: deactivate
   sign-in, disable and archive crons they own anywhere, pause their loops, disable their webhooks,
   revoke their active keychain grants, archive apps and skills in their personal scope, retire their
   personal computers (clearing the default first). An empty list for a misspelled id is your hint to
   check the spelling.
2. Show the admin the preview in plain words and get a yes. Retiring a computer destroys its disk; back up
   its workspace first if they want it.
3. Apply with `value: {"apply": true}`. Each change comes back `done` or `failed` with the error and is
   audited as the admin. Re-running is safe: finished items drop out, so a retry does only what's left.
4. Look for what it deliberately leaves, and ask the admin about each:
   - apps, skills and computers they created in shared scopes (`deployments`, `skills`, `sandboxes`
     filtered by creator) — others may rely on them;
   - their stored credentials (`keychain`) — they stay encrypted and unused once grants are revoked;
   - an admin grant — portal-only, revoked under Admins in the dashboard;
   - computers whose provider can't retire them.

Applying sets `offboardedAt`/`offboardedBy` on the person's row in the `users` table: the response's `user`
(also on the `user` detail, and `offboarded` in the `users` list) holds when and by whom; the audit log's
`user.offboard.*` entries are the change list. The row is written before any change is applied, so if it
can't be written the call fails and nothing changes. The dashboard hides offboarded people from Users until "Show offboarded" is clicked.

Conversations, memory and files stay as the record. `reactivate_user` turns sign-in back on (even after a
directory-sync removal), clears `offboardedAt`/`offboardedBy` (the audit log keeps the history), and
restores nothing else; owners or admins restore crons, loops, apps and skills
through their usual controls.

## Scheduling admin-reading work

A cron's fires run as its owner with the owner's own authority, so an org admin's
scheduled work can read what the admin could on a typed turn — no grants to set up.
Changes through the admin API stay with typed turns. Two things still need settling
at creation, not after the first fire fails:

1. **Audience.** Private-content reads (transcripts, memory, files, the scope directory)
   still require the cron's home to be the owner's own DM or an Open conversation. A
   cron created with `channel` or `participants` is homed in that room; if the room is
   not Open for the admin, those reads will refuse there. Spend, audit, egress, crons
   and config reads work from any home.
2. **Who sees the output.** Before its output goes anywhere but the admin's own DM (a
   `recipient`, or later a `retarget` from a room's conversation), tell the admin
   plainly that the cron will read admin data as them and that everyone there will see
   whatever it posts, with nothing re-checking each post. Weigh the room: say so if it
   is shared with outsiders or isolated from their personal context. Proceed only on
   their explicit yes; the move is audited and appears in the cron's history.

If part of the task can't work from where the cron will live, say so before or at
creation. Don't create a cron that will fail on its first fire without saying so.
Remember that whoever rewrites a shared cron's task becomes its owner: the fires then
run with that person's standing, not the original admin's.

## Failure modes

- `403 admin grant required for this scope` — the user isn't an org admin (or was just
  revoked). Say so; don't retry or work around it.
- `403 … carry a person's own authority — this turn runs with none` — a bot actor, an
  external audience, or a session message whose authorization chain could not be
  verified. Report it where the run delivers — never finish silently.
- `403 admin changes need the admin at the keyboard …` — a fire tried to change
  something. Report the change you would make where the run delivers; the admin
  confirms it on a turn they send.
- `403 … returns private content — ask the agent in a DM` — the shared room does not have effective Open access for this admin;
  tell the admin to ask again in a DM with you (or, for reads they want recurring
  on a schedule, to create the cron from their DM so it is homed there).
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
