# Personas

> Behind the `personas` feature flag (per person or org, off by default).

A persona is a reusable agent — a name, icon, description and instructions, plus skills,
notes and credentials — that people can use in any conversation. The conversation still
decides **who is in the room and where writes land**; the persona decides **how the agent
behaves and what it brings**. A persona is a scope, `persona:<id>`, that a conversation
_wears_ rather than one it _lives in_.

## Storage

```sql
CREATE TABLE personas (
  id             TEXT        PRIMARY KEY,           -- scope is persona:<id>
  name           TEXT        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description    TEXT        NOT NULL DEFAULT '',
  instructions   TEXT        NOT NULL DEFAULT '',
  icon_kind      TEXT        CHECK (icon_kind IN ('emoji', 'custom')),
  icon_value     TEXT,
  forked_from_id TEXT,                              -- no FK: the source may be deleted
  created_by     TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((icon_kind IS NULL) = (icon_value IS NULL))
);

CREATE TABLE persona_access (
  persona_id       TEXT        NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  grantee_scope_id TEXT        NOT NULL CHECK (grantee_scope_id ~ '^(personal|team|org|channel):.+'),
  role             TEXT        NOT NULL CHECK (role IN ('owner', 'write', 'read')),
  granted_by       TEXT        NOT NULL,
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (persona_id, grantee_scope_id)
);

ALTER TABLE sessions ADD COLUMN persona_id TEXT;  -- nullable; no FK, a deleted persona just stops applying
```

Everything else already keys off scopes: skills homed in `persona:<id>`, its memory
notebook, and keychain grants to `persona:<id>`.

## Access

| Role  | Can                                                                         |
| ----- | --------------------------------------------------------------------------- |
| owner | everything below, plus share, attach credentials, delete                    |
| write | edit name, description, instructions and icon; add or edit its skills; chat |
| read  | chat; see its instructions, access list and attached credential names       |

Holders are people (`personal:`), teams (`team:`), the org (`org:`) or Slack channels
(`channel:`). A channel grant only applies to conversations in that channel. A person's
role is the highest one reaching them. Every persona keeps at least one owner.

Checks sit where every path already flows: turn resolution (below) and the scope checks
(`canReadScope` / `canWriteScope` / `canManageScope`), so skill moves into a persona need
write. Only an owner can attach a credential, only their own, and only on a turn they
sent; readers use it through the persona but never hold it.

## Turns

A session's `persona_id` is set from the Personas page ("Chat") or by the agent
(`PUT /v1/sessions/:id/persona`). On each turn, if the sender holds a role on the persona
(counting the conversation's channel), the turn:

- reads `persona:<id>` as an extra read-only scope (its skills and notes);
- offers keychain grants to `persona:<id>` alongside the conversation's own;
- adds a `## Persona` block after the organization and conversation instructions.

If the sender has no role, the persona is skipped and the block says so. Writes (memory,
files, crons) stay in the conversation's scope.

Unlike a project, a persona is not a place conversations live. A conversation with a
persona stays in the scope it started in (your DM, a channel, a group), so only the
people who could already see that conversation can see it. Holding a role on a persona,
even owner, shows you nothing of other people's chats with it; the sidebar groups only
your own conversations under the persona.

## Forking

The `persona-fork` skill uses only these APIs: create a persona with `forkedFromId`, copy
instructions, icon and description, copy skills as snapshots, then offer to attach the
forker's own credentials. Credentials and access are never copied.

## API

`GET|POST /v1/personas`, `GET|PATCH|DELETE /v1/personas/:id`,
`PUT /v1/personas/:id/access`, `POST /v1/personas/:id/credentials`,
`DELETE /v1/personas/:id/credentials/:grantId`, `PUT /v1/sessions/:id/persona`. Listed in
`/v1/apis` when the flag is on.
