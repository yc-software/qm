# Admin plugin

A minimal **admin surface** for the qm — the operator/admin plane from
spec §14, delivered as an _added_ plugin (like the Slack plugin). It is a separate
process that talks to the core **only** over the admin governance API; the core has
zero dependency on it. Don't run it and nothing about the core changes.

You reach it through the **portal** (real SSO); the surface trusts the portal-synthesized
`admin=<sub>` cookie as identity and asks the **core** whether that principal is an admin
(`GET /api/whoami` → core `GET /v1/admin/whoami` → `canAdminister`). It holds **no admin id list**
of its own. Pick a scope, then either **edit governance** (command policy, SOUL, egress),
**manage users** (the org-wide **Users** tab), or read the **observability** views — Metrics,
History, Files, Live, Errors, Audit, Skills, Crons, Deployments, Volumes, Retention.
The **Users** tab (org-wide, org_admin-only, like Retention) lists everyone who has
used the agent (from session metadata — no content) with admin status joined, plus the
authoritative grant list, and lets an org_admin **promote** a principal to org_admin
or **revoke** — every mutation attributed and audited, the last org_admin protected.
(`org_admin` is the only supported role for now; `team_admin` was removed — team-scoped admin
observability is future work. See `src/admin/admin-service.ts`.) Metrics
shows TTFT + turn/queue/execution-latency
percentiles, throughput, and a daily TTFT trend. History (conversation listing with a
by-type usage rollup, drilling into transcripts with per-turn model-context breakdowns), Files
(workspace contents), and Live (ongoing/recent runs) are **top-down content** views: an
org-scope query spans the whole org; a narrower scope is limited to that scope. Every
action is authorized in the core and audited.
**Retention** is org-wide (no scope picker): DAU/WAU/MAU, new-vs-returning, weekly retention cohorts,
stickiness, and per-user distributions — derived from session/participant metadata only
(channel attribution is approximate, since entries carry no author principal).

## Run

```bash

HARNESS=mock PORT=8080 ORG_ID=acme npm start


cd plugins/admin
CORE_API_URL=http://localhost:8080 CORE_ORG_ID=acme PORT=8090 npm start

```

No build step, no runtime dependencies (pure `node:http` + native TS). Node 24+.

Env: `CORE_API_URL` (default `http://localhost:8080`), `CORE_ORG_ID` (default `acme`),
`PORT` (default `8090`) and `CORE_SIGNING_SECRET` (required outside isolated development). The
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
`POST /api/grants` (promote) · `DELETE /api/grants/:principalId?scope=&role=` (revoke) — all
proxied to the core's `/v1/admin/…` with the admin actor injected. Grant mutation is
**org_admin-only** (enforced in the core, not the surface).
