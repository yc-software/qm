# Admin plugin

A minimal **admin surface** for the qm — the operator/admin plane from
spec §14, delivered as an _added_ plugin (like the Slack plugin). It is a separate
process that talks to the core **only** over the admin governance API; the core has
zero dependency on it. Don't run it and nothing about the core changes.

You reach it through the **portal** (real SSO); the surface trusts the portal-synthesized
`admin=<sub>` cookie as identity and asks the **core** whether that principal is an admin
(`GET /api/whoami` → core `GET /v1/admin/whoami` → `canAdminister`). It holds **no admin id list**
of its own. Pick a scope, then either **edit governance** (command policy, SOUL, egress),
**manage users** (the org-wide **Users** tab), or read the **observability** views —
History, Files, Live, Errors, Audit, Skills, Crons, Deployments, Volumes.
The **Users** tab (org-wide, org_admin-only) lists everyone who has
used the agent (from session metadata — no content) with admin status joined, plus the
authoritative grant list, and lets an org_admin **promote** a principal to org_admin
or **revoke** — every mutation attributed and audited, the last org_admin protected.
**Invite teammate** adds someone by email with Member or Org admin access. The invite form grants access without an
expiration date. Teammates appear in Users before their
first session. Addresses already admitted through the domain or allow-list may receive a
sign-in invitation too. Re-inviting an admin never removes their admin role.
Invitations are durable and listed with their access status. Revoke ends access immediately.
Invitation email uses Resend when configured. Teammate invitations contain a single-use sign-in link valid for 24 hours. If delivery is unavailable or fails, Admin shows the same link with a copy control after the invitation is created. Redemption checks current membership and claims the token through durable storage; revocation or a new invitation invalidates earlier links. Company access displays the web email domain and the local Slack allow-list; these are deployment settings, not editable Admin policy.
The existing external-user API still requires an expiry and rejects org members.
Teammate invitations and revocations are restricted to the Admin surface.
(`org_admin` is the only supported role for now; `team_admin` was removed — team-scoped admin
observability is future work. See `src/admin/admin-service.ts`.) History (conversation listing with a
by-type usage rollup, drilling into transcripts with per-turn model-context breakdowns), Files
(workspace contents), and Live (ongoing/recent runs) are **top-down content** views: an
org-scope query spans the whole org; a narrower scope is limited to that scope. Every
action is authorized in the core and audited.

## Run

```bash

HARNESS=mock PORT=8080 ORG_ID=acme npm start


cd plugins/admin
CORE_API_URL=http://localhost:8080 CORE_ORG_ID=acme PORT=8090 npm start

```

No separate build command is needed. The Node 24+ server bundles the admin Lit modules once at startup and embeds them in the existing CSP-hashed script. The backend uses `node:http` and native TypeScript, with optional Sentry error reporting.

The admin tabs render through the Lit modules in `ui/`, with `ui/admin.ts` as their shared entry point. They use the existing light-DOM elements, classes, and styles without layout wrappers. Settings drafts, validation, dirty state, and save feedback render from state; list views own filtering, pagination, and editor state. Stable row keys preserve focus. Shared table, card, and list templates live in `ui/shared.ts`. Specialized safe Markdown, XML, and tool-output formatters remain shared adapters in the shell.

The shared admin controller retains routing, API calls, and change-review dialogs. Successful saves commit the submitted snapshot, preserving newer edits made while a request was in flight. Scope and render generations prevent stale requests from replacing a newer page. Related settings refresh independently so changing one section cannot discard neighboring drafts. Run `npm test` and `npm run typecheck` from this directory after changing the UI.

Env: `CORE_API_URL` (default `http://localhost:8080`), `CORE_ORG_ID` (default `acme`),
`PORT` (default `8090`), `CORE_SIGNING_SECRET` (required outside isolated development), and
`INBOX_USERS` (the same comma-separated principal allowlist used by Inbox and Calendar). The
portal also supplies a short-lived `x-portal-identity` token, which this surface forwards to core.
There is **no** `ADMIN_PRINCIPALS` — admin identity + role + scope live solely in the core's
durable, mutable `admin_grants` store, and this surface derives admin status from it via
`/api/whoami`. `ADMIN_GRANTS` (env) is now only the **one-time seed** for an empty store; after
that, admins are promoted/revoked at runtime through the Users tab (a redeploy never clobbers
runtime grants).

## How it stays safe

- **The browser never holds an admin credential.** The portal supplies the verified identity in a
  short-lived signed header; the compatibility cookie alone is not accepted when auth is configured.
  Core verifies the token and decides admin-ness on every action.
- **All authority is enforced in the core**, not here (spec §14): the core authorizes
  every read and write against `admin_grants` (`canAdminister`) and refuses scopes you don't
  administer (403). `GET /api/whoami` reports that same grant state (it grants no new power).
- **Content reads are scope-authorized and audited.** Transcript, model-request, file, memory,
  keychain, and other sensitive bodies are served only to admins of the owning scope, and every
  read lands in the audit log.

## Endpoints it serves

`GET /` (UI) · `GET /healthz` · `GET /api/me` + `GET /api/whoami` (identity + derived admin
status) · `POST /api/logout` ·
`GET /api/scopes/:scopeId` + `PUT /api/scopes/:scopeId/:resource`
(`command-policy|soul|egress`) ·
`GET /api/{metrics|errors|audit|crons|deployments|skills|sessions|runs|files}?scope=` ·
`GET /api/sessions/:id?scope=` (transcript) · `GET /api/sessions/:id/llm?scope=`
(captured model requests) · `GET /api/files/read?id=` + `GET /api/files/download?id=` (document content) ·
`GET /api/retention` (org-wide) · `GET /api/users` (org-wide; roster + grants) ·
`POST /api/grants` (promote) · `DELETE /api/grants/:principalId?scope=&role=` (revoke) ·
`POST /api/external-users` (invite) · `DELETE /api/external-users/:email` (revoke) — all
proxied to the core's `/v1/admin/…` with the admin actor injected. Grant and external-user
mutation is **org_admin-only** (enforced in the core, not the surface).

## Slack setup

Hosted Add to Slack is shown only when core reports `installAvailable`, enabled by
`QM_SLACK_SERVICE_URL` and its matching `QM_SLACK_SERVICE_TOKEN`. Public deployments
without that service lead with the preconfigured Slack app manifest and token form.
Connected hosted apps offer Re-add to Slack; custom apps must be disconnected before
switching to the hosted app. Both paths retain the custom app setup instructions.
