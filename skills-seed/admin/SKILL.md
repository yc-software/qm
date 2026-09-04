---
name: admin
description: Act for an org admin — the admin API (scope directory, per-scope config & SOUL, any scope's memory, transcripts & captured prompts, files, user roster, audit/errors/metrics/egress) accepts your token when the user you're talking to is an org admin and started this turn themselves. Use when an admin asks you to inspect or change anything org-wide or in another scope, or anyone asks whether they're an admin.
---

# admin — act for an org admin, from chat

A connector skill: no new tool. When the chatting user is an org admin (your system
prompt says so — "Acting for an org admin"), the `/v1/admin/*` endpoints accept your
token. You are acting **as them**: authorization is re-checked against the live grant
store on every call, and every call is audited under their name. Two standing rules:
**confirm before any mutation** (state exactly what you'll change and where), and report
afterwards exactly what changed. Reads are fine to just do.

Three limits the API enforces (don't offer what it will refuse):

- Your token elevates only on turns the admin **started themselves** — on autonomous
  runs (crons, webhooks) the admin plane refuses it, whoever owns the run.
- Reads that return private content — transcripts, files, notebooks, logs, another
  scope's config — only work from a **DM** with the admin. Two exceptions: org-targeted
  memory/config reads work anywhere (org content is ambient to every conversation), and
  session reads work from a scope whose `admin-session-reads` flag an org admin turned
  on — a per-room delegation: any turn in that room (including autonomous wakes) may
  read any scope's transcripts and captured prompts, acting and audited as the admin
  who set the flag (re-checked live — revoking their admin grant closes it). Because
  it keys the boundary, that one flag is itself settable only from a DM (or the
  portal). Other mutations work anywhere; the room sees
  what changed, by design.
- **Grant changes (promote/revoke) are portal-only** through you — see below.

All calls share one shape — only method/path/body vary:

```bash
curl -fsS -H "x-agent-capability: $AGENT_API_TOKEN" "$AGENT_API_URL/v1/admin/..."
```

Anyone can check admin status (this is also how you answer "am I an admin?"):

```bash
GET /v1/admin/whoami        → {"isAdmin":true,"role":"org_admin","scopeId":"org:…"} or {"isAdmin":false}
```

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
                                                admin-session-reads | connectors | service-credentials |
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

## Admin grants (promote / revoke)

Not available through you: who governs the org changes only in the admin dashboard,
where the admin acts directly. If asked, point them there — don't try the API
(`POST/DELETE /v1/admin/grants` refuses agent tokens).

## Failure modes

- `403 admin grant required for this scope` — the user isn't an org admin (or was just
  revoked). Say so; don't retry or work around it.
- `403 … require a turn the admin started themselves` — this is an autonomous run
  (cron/webhook); admin actions only ride turns the admin personally initiated. Say so.
- `403 … returns private content — ask the agent in a DM` — you're in a shared room;
  tell the admin to ask again in a DM with you (or, for session reads they want
  recurring in this room, to turn on this scope's `admin-session-reads` flag — from
  their DM, never from here).
- `403 … grant changes (promote/revoke) are portal-only` — point them at the dashboard.
- `403 capability token not valid for this route` — this core predates agent admin
  access; the user must use the admin dashboard.
