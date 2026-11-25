# Personas

> Behind the `personas` feature flag (per person or org, off by default).

A persona is a reusable agent — a name, icon, description and instructions, plus skills,
notes and credentials — that people can use in any conversation. The conversation still
decides **who is in the room and where writes land**, except memory in a room that pins the
persona ([Turns](#turns)); the persona decides **how the agent behaves and what it brings**. A persona is a scope, `persona:<id>`, that a conversation
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
- `persona_versions` (migration `users/v2/0005-persona-versions`): one row per
  `(persona_id, version)` holding the name, description, instructions and icon as they
  were saved, `edited_by UUID REFERENCES users(id)`, `edited_at`, and `restored_from`
  when the save was a rollback. Creating a persona writes version 1; an edit that changes
  nothing writes no version. Deleting the persona deletes its versions.
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

Holders are people (`personal:`), teams (`team:`), the org (`org:`), Slack channels
(`channel:`) or groups such as Slack group DMs (`group:`). A channel or group can only hold
read, and its grant only applies to conversations in it. A person's
role is the highest one reaching them. Every persona keeps at least one owner.

An owner can also **pin** a persona in a channel or group it's shared with (`pinned: true` on that
channel's access entry, column `persona_access.pinned`, migration
`users/v2/0006-persona-channel-pins`). A channel or group pins at most one persona; pinning a second
one is refused until the first is unpinned. Removing the channel's grant unpins it.

Checks sit where every path already flows: turn resolution (below) and the scope checks
(`canReadScope` / `canWriteScope` / `canManageScope`), so skill moves into a persona need
write. Only an owner can attach a credential, only their own, and attaching one raises an
approval card to them; readers use it through the persona but never hold it. Detaching a
credential and changing who holds a role also take an owner; deleting the persona takes an
owner and their approval card.

**Owners leaving.** When a persona's last active owner is deactivated or offboarded, the
default admin becomes an owner: the active org admin with the oldest grant, so the admins named
in `ADMIN_GRANTS` at first boot come first. Offboarding someone lists each persona their
departure leaves with no active owner, and the admin it goes to; other deactivations, and personas
already left without one, are picked up within five minutes. The departed owner's row stays, so
reactivating them restores their role.

## Turns

A session's `persona_id` is set from the Personas page ("Chat") or by the agent
(`PUT /v1/sessions/:id/persona`). A conversation in a channel or group with a pinned persona
and no persona of its own wears the pinned one; the `## Persona` block then says it was pinned
and how to change that.
A turn without a persona, from a person with personas enabled, gets a short `## Personas`
context block saying what personas do and where the API is, so the agent can offer one. There is no lock: the channel's own instructions and skills
still apply, and anyone may still pick another persona for one conversation. On each turn,
if the sender holds a role on the persona (counting the conversation's channel), the turn:

- reads `persona:<id>` as an extra read-only scope (its skills and notes);
- offers keychain grants to `persona:<id>` alongside the conversation's own;
- adds a `## Persona` block after the organization and conversation instructions.

If the sender has no role, the persona is skipped and the block says so. Files stay in the
conversation's scope, and so does memory in a DM or in a conversation that only picked the
persona (persona owners and write holders can also write directly to `persona:<id>` memory).
Crons created in a DM while wearing a persona default to being owned by that persona when the
sender holds write or owner on it (override with `persona: null`); persona-owned crons are
managed by the persona's owners and write holders, and when posting to a DM they fan out into
linked per-person copies when shared with teammates.

A channel or group that pins a persona uses the persona's notebook in place of its own:
automatic capture and the `memory` tool save there, and the room's own notebook is kept but
not read by those turns. Every conversation that uses the persona reads the persona's
notebook, so what one pinned room remembers is shown in the others and to everyone who can
use the persona, including people who are not in that room. A turn in a pinned room keeps
to the room's own notebook when its member list is missing or names anyone from outside
the organization, when the `personas` flag does not reach its sender, and when its
conversation picked a different persona. A person's message in a Slack channel with a
guest carries no member list, and neither does a web conversation opened in a Slack
channel. A cron or other automation fire takes its member list from the stored roster,
which leaves workspace guests out, so in a channel with a guest it uses the persona's
notebook. The room's own nightly memory tidy keeps to the room's notebook, and the
persona's notebook gets a nightly tidy of its own. With `MEMORY_PROVIDER_CONFIG` set, the
`default` route has to serve the `persona` kind ([memory providers](./memory-providers.md)).

An org admin can route conversations to personas with a `turn_start` decision rule (Settings →
Decision rules) whose option has the action `use_persona` and a `persona` id, or `*` to expand
that option at turn time into every persona the sender can use in that scope (ordered
alphabetically by name; skipped if fewer than two options remain). The turn evaluates
its `turn_start` rules once, before it settles its persona, and model selection reuses the same
verdicts, so one enforcing rule may pick a persona while another picks a runtime: the hook
allows one enforcing rule per action. The state the rules see includes the conversation kind
(`dm`, `group` or `channel`), so "only in DMs" and "addressed to this persona" belong in the
rule's question and options. Ambient turns are not routed. When the enforcing rule picks a
persona the conversation isn't already wearing and the sender holds a role on it, the
conversation adopts it and that turn's context names the rule and how to switch; otherwise the
persona is unchanged and the context names the rule, the persona and who can fix it.

A cron set up in a conversation with a persona fires as that persona: when it fires, the
scheduler looks up the persona of the cron's home conversation and the fire's turn wears it
under the same role check.

Whatever a turn wearing a persona posts carries the persona's id and name on its delivery
destination: replies, posts to other conversations, and cron output. Slack posts and
edits those messages under the persona's name and icon, ahead of any deployment-wide
`SLACK_BOT_DISPLAY_NAME`/`SLACK_BOT_ICON_EMOJI` override (needs `chat:write.customize`, which
the app manifest requests) (a Unicode emoji maps to its Slack
shortcode; a custom emoji is used by name; an image icon is sent as its URL; no icon keeps the default), and ends them with a
`Persona: <name>` context line linking to the persona's page, next to the cron settings
link when there is one. File uploads and the in-progress task card still show the app's own
identity, since Slack doesn't let an app rename those.

Unlike a project, a persona is not a place conversations live. A conversation with a
persona stays in the scope it started in (your DM, a channel, a group), so only the
people who could already see that conversation can see it. Holding a role on a persona,
even owner, shows you nothing of other people's chats with it, apart from what a room that
pins it saved to its notebook ([Turns](#turns)); the sidebar groups only your own
conversations under the persona.

## Page

`/personas/<id>` is the persona's page. Under its instructions it has one section each for
skills, crons, credentials, Slack channels, who has access, and history, each with its own
add control for people whose role allows it:

- **Skills**: "New skill" opens the skill editor homed in `persona:<id>`; "Ask QM" opens a
  chat wearing the persona with a request started.
- **Crons**: "New cron" opens a chat wearing the persona; a cron made there runs as it.
- **Credentials** (owner): attach one of your own credentials or detach one.
- **Slack channels** (owner): "Add channel" searches the channels you are in, in place; a
  channel can only be given read.
- **Who has access**: each person, team or org grant with its role. Owners add people or
  everyone in the org ("Add people", or Share on the page or the Personas list opens the same
  search), and change or remove a role from its row; each change saves at once. The last owner's
  row can't be demoted or removed. Others see who the owners are. A grantee the `personas` flag
  doesn't reach (the person, or the whole org for org, team and channel grants) is marked, with
  where an admin turns it on.
- **History**: loads on first open, 20 versions at a time with "Show older" for the rest,
  each saying who saved it and when. Opening one shows it as it was. Writers can roll back to
  any of them; a rollback is saved as a new version, so nothing is lost.

## Forking

Forking has one owner, the `persona-fork` skill; the page's Fork button asks QM to run it.
It uses only these APIs: create a persona, copy instructions, icon and description, copy
skills as snapshots, then offer to attach the forker's own credentials. Credentials and
access are never copied.

## API

`GET|POST /v1/personas`, `GET|PATCH|DELETE /v1/personas/:id` (each access entry carries
`personasEnabled`, whether the flag reaches that grantee),
`PUT /v1/personas/:id/access`, `POST /v1/personas/:id/credentials`,
`DELETE /v1/personas/:id/credentials/:grantId`, `GET /v1/personas/:id/versions` (newest first, 20 a page by default,
`?before=&limit=`; who and when, with content only on `&full=1`),
`POST /v1/personas/:id/versions/:version/restore`, `PUT /v1/sessions/:id/persona`. Listed in
`/v1/apis` when the flag is on.

## Default model

A persona can carry a default model, stored as the runtime selection of its `persona:<id>`
scope and set from the Model panel on the persona's page (or `PUT /v1/runtime-config` with
that scope; writers only). When a conversation that has no model yet takes the persona,
core sets the conversation's model to it: on `PUT /v1/sessions/:id/persona`, which returns
it as `sessionModelId` so the web composer opens on it, and on the first turn in a channel
or group that pins the persona. From there it is the conversation's own model: a model the
person picks for the turn still wins, and later turns keep whatever model it last used.
