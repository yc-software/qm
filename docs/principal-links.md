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

- **The directory member is canonical.** When the company runs Slack, the
  Slack-verified directory principal is the person's canonical id and the
  trusted OIDC subject is the linked sign-in. The admin API refuses a link
  whose linked side is a directory member, by principal id or Slack id.
- **A link never creates an admin.** A sign-in that holds an org admin grant
  can only be linked to a canonical principal that is already an admin.
- **Links are flat.** A canonical principal is never itself linked onward, and
  a linked sign-in cannot become canonical for others.
- **Evidence is required.** Every link records how the two identities were
  verified as one person and which admin created it.
- **Links are reversible.** Deleting a link restores two separate principals.
  Records written while the link existed stay under the canonical id, so a
  wrong link is an incident to reconcile, not just a row to delete.
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

Links live in the `principal_links` durable map of the company database.
