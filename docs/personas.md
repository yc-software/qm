# Personas

> Behind the `personas` feature flag (per person or org, off by default).

A persona is a reusable agent — a name, icon, description and instructions, plus skills,
notes and credentials — that people can use in any conversation. The conversation still
decides **who is in the room and where writes land**; the persona decides **how the agent
behaves and what it brings**. A persona is a scope, `persona:<id>`, that a conversation
_wears_ rather than one it _lives in_.

## Storage

The tables are created by migration `users/v2/0004-personas` in the users chain, so the
foreign keys to `users(id)` exist wherever users are merged. The authoritative shape is
`src/personas/persona-schema.ts`; in short:

- `personas`: `id`, `name`, `description`, `instructions`, `icon` (JSONB, the project icon
  shape), `created_by UUID REFERENCES users(id)`, timestamps.
- `persona_access`: one row per `(persona_id, grantee_scope_id)` with `role` owner, write
  or read, `granted_by UUID REFERENCES users(id)`, `granted_at`. Deleting the persona
  deletes its rows.
- `sessions.persona_id`: nullable, no foreign key; a deleted persona just stops applying.

Roles live in their own table rather than in `acl_grants`, whose permissions are only
read and write; a persona also needs owner (sharing, credentials, deletion).

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

## Channel personas

When `personas` is on for the whole org (never per person), an owner of a persona who is in a
Slack channel can make it that channel's persona (`PUT /v1/channels/:channel/persona`). Every
conversation in the channel then wears it, for every sender, as if the channel held read on it;
a session's own persona is ignored there and can't be set. Changing or clearing it takes the
lock below. A channel wears at most one persona; one persona can be worn by several channels.

The setting is one row per channel in the `persona_channel_defaults` durable map, keyed by the
channel scope: `{ scopeId: "channel:<id>", personaId, setBy, setAt }`, indexed on
`personaId`. Like `sessions.persona_id` it has no foreign key: a deleted persona just stops
applying. Setting or clearing it posts a notice in the channel.

**The lock.** While a channel wears a persona, only the persona's writers and owners (held
through a person, team or the org grant, never through the channel's own grant) or an org admin,
on a turn they sent themselves, can change the channel's instructions, standing orders or
skills, including sharing a skill into the channel. Everyone else is refused with an owner
named; a refusal never names a private channel, or its persona, to someone outside it.

**Owners leaving.** When a persona's last active owner is deactivated or offboarded, the
default admin becomes an owner: the active org admin with the oldest grant, so the admins named
in `ADMIN_GRANTS` at first boot come first. Offboarding lists each handover with the admin it
goes to; deactivations outside offboarding are picked up within five minutes. The departed
owner's row stays, so reactivating them restores their role. Access changes that would leave a
persona with no active owner are refused.

## Forking

Forking has one owner, the `persona-fork` skill; the page's Fork button asks QM to run it.
It uses only these APIs: create a persona, copy instructions, icon and description, copy
skills as snapshots, then offer to attach the forker's own credentials. Credentials and
access are never copied.

## API

`GET|POST /v1/personas`, `GET|PATCH|DELETE /v1/personas/:id`,
`PUT /v1/personas/:id/access`, `POST /v1/personas/:id/credentials`,
`DELETE /v1/personas/:id/credentials/:grantId`, `PUT /v1/sessions/:id/persona`,
`GET|PUT /v1/channels/:channel/persona`. Listed in
`/v1/apis` when the flag is on.
