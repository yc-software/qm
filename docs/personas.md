# Personas

> Status: design, not implemented. Behind the `personas` feature flag (off by default).

A persona is a reusable agent configuration — a name, a soul, skills, credentials and
a default runtime — that people can chat with in any context. A project or channel
decides **who is in the room and what data is shared**; a persona decides **how the
agent behaves and what it brings**. Today a scope bundles both; a persona is a scope
the agent *wears* rather than one it *lives in*.

## Shape

A persona is a new scope kind, `persona:<id>`. Everything it carries already keys off
scopes, so nothing new is stored for it:

| Part | Where it lives (existing) |
|---|---|
| Soul / system prompt | `soul_configs` row for `persona:<id>` |
| Skills | skills homed in `persona:<id>` |
| Credentials | keychain grants to `persona:<id>` |
| Default runtime | scoped runtime setting for `persona:<id>` |
| Notes / knowledge | memory notebook for `persona:<id>` (read-only in turns, curated by writers) |

The only new record is the persona's identity:

```jsonc
// durable map "personas" (new table, one JSON value per id)
{
  "id": "4b0c…",                       // uuid; scope is persona:4b0c…
  "orgId": "acme",
  "name": "Ada",
  "description": "Files expense receipts",
  "icon": { "kind": "emoji", "value": "🧾" },   // same shape as project icons
  "forkedFrom": { "id": "91fe…", "name": "Receipts" },  // optional
  "createdBy": "U123",
  "createdAt": 1793836800000,
  "updatedAt": 1793836800000
}
```

## Access

Three roles. Every holder is a scope — a person (`personal:`), a team (`team:`), the
whole org (`org:`) or a Slack channel (`channel:`) — and all three are rows in the existing `acl_grants` table, so
sharing works like skills and apps today:

| Role | Can | Row (`owner_scope_id`, `path`, `grantee_scope_id`, `permission`) |
|---|---|---|
| Owner | everything below, plus attach credentials, share, delete | `persona:4b0c…`, `persona:4b0c…`, `team:ops`, `owner` |
| Writer | edit soul, skills, runtime and notes; chat | `persona:4b0c…`, `persona:4b0c…`, `personal:U456`, `write` |
| Reader | chat; view the config summary (credential names, never secrets) | `persona:4b0c…`, `persona:4b0c…`, `org:acme`, `read` |

A person's role is the highest granted to them, their teams or the org. A persona always
keeps at least one owner. `Permission` gains `owner`; only `persona:` refs use it.

Enforcement sits at the two layers every path already flows through:

1. **Turns** — resolution adds the persona scope only when the person whose message (or
   cron) drives the turn holds a role. Otherwise the turn runs without it and a note
   says why.
2. **Writes** — `canManageScope` / `managesArtifactHome` answer for `persona:` scopes:
   writer or owner for soul, skills, runtime and notes; owner for credential grants,
   access and delete.

A `channel:` grant (normally `read`) means anyone in that channel can use the persona
**there** — it confers nothing outside the channel. That is how `acl_grants` already
matches channel grantees (the session's scope must be the channel), so it needs no new
check.

Credentials can only be attached by an owner, so readers use them *through* the persona
without being able to take them elsewhere.

## Using a persona

A session gets an optional `persona_id`. Set it when starting a chat ("Chat with Ada"
on the personas page) or switch an existing session. When set, resolution:

- adds `persona:<id>` to the turn's read-only scopes (skills, notebook);
- includes keychain grants to `persona:<id>` alongside the context's;
- composes the soul as org → persona → context guidance, and uses the persona's runtime
  unless the session overrides it;
- adds one context note: you're acting as *Ada* in *this context*; skills and
  credentials come from Ada, audience and data rules from the context.

### In Slack channels

Owners add channels from the persona's page or by asking the agent ("give Ada
#finance-ops"), which writes a `channel:` grant and can mark the persona as the
channel's **default**: new threads there start with `persona_id` set, so people just
talk to QM and get Ada. The default lives in a new scoped-config table, `channel_persona_defaults`
(one row per channel); without one, anyone can still say "use Ada" in a thread and the agent
switches that session. Removing the grant clears the default.

Writes (memory, files, crons) stay in the context's own scope, as now. In a shared
channel everyone present sees the replies; only the person invoking needs a role.

## Forking

A `persona-fork` skill, built only from the existing APIs: create a persona owned by
the forker, copy the soul, runtime and skills (snapshots, not links), record
`forkedFrom`, then list the credentials the source uses and offer to attach the
forker's own. Credentials and grants are never copied. Forking needs read access.

## Personas page

`/personas` in the web UI, on the same group-by backbone as the other artifact pages:
every persona you hold a role on, grouped by role, with icon, name, owner(s) and
description. Row actions: Chat, Fork, and Edit / Share for writers and owners.

## Schema and config changes

- New durable-map table `personas` (shape above).
- `sessions.persona_id TEXT NULL` — nullable, no backfill.
- `acl_grants`: no DDL; new rows with `path` `persona:<id>` and `permission` `owner`
  in addition to `read`/`write`.
- New scoped-config durable-map table `channel_persona_defaults`
  (`id` = channel scope, `json` = `{ "scopeId": "channel:C…", "personaId": "…" }`).
- New scope kind `persona` in existing scope-id text columns; no DDL.
- New feature flag `personas`, per person or org, off by default. No env vars.

## Later, not now

@-mentioning or DMing a persona directly; a project naming a default persona;
swarm workers spawned as personas.
