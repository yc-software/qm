# Principal links

A person can reach qm through several sign-ins: a Slack account, an email
magic link, or a trusted OIDC provider. Each produces its own principal id
(`jordan@acme.test`, `U0JORDAN`, `oidc:<issuer-hash>:<subject>`). Without a
link, qm treats them as different people: a credential dropped from Slack is
owned by the email principal, and the same founder signed in through OIDC is
told the link is for someone else.

A **principal link** records that two principal ids are one person. One id is
the **canonical principal**; the other is a **linked sign-in**. Every
same-person check in core (`personKey`, `samePerson`) folds a linked sign-in to
its canonical principal, so ownership of credentials, admin grants, sessions,
approvals, and secret drops recorded under either id belongs to the person.
New writes use the canonical id: the identity service classifies a linked
sign-in as its canonical principal, the portal resolves the session subject
before proxying, and the keychain stores credentials under the canonical owner.

## Rules

- **Administrative links keep the directory member canonical.** When the company runs Slack, the
  Slack-verified directory principal is the person's canonical id and the
  trusted OIDC subject is the linked sign-in. The admin API refuses a link
  whose linked side is a directory member, by principal id or Slack id.
- **A link never creates an admin.** A sign-in that holds an org admin grant
  can only be linked to a canonical principal that is already an admin.
- **Links are flat.** A canonical principal is never itself linked onward, and
  a linked sign-in cannot become canonical for others.
- **Only people are linked.** A QM system actor (`system:…`) is QM itself, and a
  Slack bot or app is software, so a link with either one on either side is
  refused. The admin API answers 400, and the Slack connect flow answers 409
  with "These accounts need an administrator's help to connect. Your existing
  data has not been moved."
- **The directory says who is a bot.** Each directory sync copies Slack's
  `is_bot` for every member into `directory_members.is_bot`, as true or false.
  It stays empty (NULL) until a sync has written it, and a sign-in Slack doesn't
  list, such as an OIDC sign-in, has no row at all. QM never reads an empty flag
  as "a person":
  - **Linking.** A sign-in whose row says it is a bot counts as a bot on either
    side of a link. When the flag is empty, the link check falls back to the
    sign-in's QM user, which is marked as an app once the bot has spoken to QM or
    a sync has listed it as a bot.
  - **Repair at each sync.** A sign-in whose row says it is a bot, but that is
    linked onto someone else's user, moves to a new app user of its own. The same
    transaction writes a `user_sign_in_split` audit event with the link's
    evidence and the admin who made it. An app user becomes a person again only
    when every one of its sign-ins is listed and listed as a person: a sign-in
    Slack doesn't list is no evidence, the same as an empty flag. Any other app
    user with more than one sign-in stays an app, and the audit log records a
    `user_sign_in_review` event with each sign-in's signal, once for each
    distinct set of signals. An empty flag neither splits nor resets anyone.
  - **Turns.** A turn is refused until an admin deletes the link when its speaker
    is a bot joined to anyone by a link, or when the speaker's sign-in or its
    canonical sign-in counts as a bot by the link check's rule. A user whose main
    sign-in is a Slack bot is not split automatically, so their turns stay
    refused. So does an app user the sync leaves for review, even when one of its
    sign-ins is listed as a person; once an admin deletes the link, each sign-in
    works on its own again.
- **Bot work stays out of a person's projects.** Work that carries the bot marker
  gets 403 from the project tools, even when the bot is a project member through a
  channel roster.
- **Evidence is required.** Every link records how the two identities were
  verified as one person and which admin created it.
- **Linking merges the users row.** If the linked sign-in already has its own
  user (it is that user's only sign-in), linking folds it into the canonical
  person's user in the same transaction (earliest first-seen time, earliest
  offboarding, and the person's kind) and deletes it.
- **Links are reversible.** Deleting a link restores two separate principals.
  Records written while the link existed stay under the canonical id,
  including the merged user: the sign-in gets a new user of its own only
  when it next writes to QM. A wrong link is an incident to reconcile, not
  just a row to delete.
- **Deactivation follows the person.** Deactivating either id deactivates both.

## Admin API

Org admins manage links through the admin surface; the agent cannot.

```
GET    /v1/admin/principal-links
POST   /v1/admin/principal-links      { principalId, canonicalId, evidence }
DELETE /v1/admin/principal-links/:principalId
```

Surfaces resolve a sign-in with a source-authenticated read:

```
GET /v1/principals/:id/canonical   → { principalId, canonicalId }
```

The portal caches the answer for one minute and refuses to proxy (503) when
core cannot answer, rather than acting as the unresolved subject. A deleted
link therefore stays effective for at most a minute of cached sessions.

Each user has a generated UUID (`users.id`). Every sign-in, including the
person's main one, is a row in `user_links` (`alias_id` → `user_id`), so a
link is one more alias on an existing user. `users.primary_alias` names the
main sign-in, which is the canonical id QM resolves to; a constraint keeps it
one of the user's own aliases. `linked_by` (and `users.offboarded_by`) point at
the acting admin's user. An actor QM has not met yet gets a user row with no
first-seen time, so they are referenced without being listed. Directory-derived
links have no `linked_by`. Sign-ins are stored folded: emails lower-cased.

## Attested actors

Memory providers with `attestActor` and attested MCP connectors receive the
canonical id in the `x-qm-actor` header, so every linked sign-in reaches them
as one person. QM attests only ids of 1 to 256 visible ASCII characters (`!`
through `~`), the rule the credential broker also applies to its actor; the
broker checks the turn's own principal id and sends it unchanged. Slack
ids and OIDC principals (`oidc:<issuer hash>:<subject>`) are ASCII; an email
principal with non-ASCII characters, or any id over 256 characters, is not
attested. QM makes no call for such a member and reports `invalid_actor`;
link them to a conforming canonical id.

An attested call reads as that person, so its answer can hold what only they may
see. QM therefore attests a person only to that person, in their own personal
scope: never where others read the answer, never in someone else's personal
scope, and never for a QM system actor (`system:…`) or for a Slack bot's work
that runs in the person's name. A memory route to an
`attestActor` provider may list only `personal` or `personal:<id>` selectors, and
QM refuses any other at startup. Attested MCP connectors are offered and called
only in the person's direct conversation with QM, not in channels, group
conversations or projects, unless an administrator sets the connector's
`attestAudience` to `any` ([mcp-connectors.md](./mcp-connectors.md)): the answer
then reaches everyone in the conversation, so set it only for a connector whose
answers its people may share there. Without `any`, a scheduled turn (a cron,
monitor, loop or webhook) counts as that conversation only when it runs there
and its answer goes back there; one that delivers to a teammate or a channel
attests nobody. The credential broker refuses an actor-attested credential anywhere
else with `private_only`, unless the credential's `injection.audience` is `any`
(which requires `injection.actor`). It then follows the same rule as such a
connector: in every conversation, the internal person the turn acts for, never a
QM system actor, guest or bot. A published
app's token belongs to its publisher's personal scope, so apps attest their
publisher.

## Self-service Slack linking

The dedicated Connect Slack flow preserves the signed-in web principal as canonical, keeping its existing connector ownership. Completion verifies a short-lived signed ticket, Composio account ownership, Slack user identity, and the installed company workspace before linking the directory member. Existing credentials or Composio accounts on the Slack principal require support instead of being silently stranded. Email similarity is not proof of identity.
