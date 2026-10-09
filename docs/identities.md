# People and identities

A person in QM is a **principal**: a row with a UUID, a kind (`person` or `agent`) and a display name. Everything
stored — session participants, owners, memory notebooks, keychain entries, grants, audit and spend labels — refers to
principal UUIDs. A person's personal space is `personal:<principal uuid>`.

Each way of reaching a person is an **identity** that points at a principal:

| provider | external id            |
| -------- | ---------------------- |
| `oidc`   | the sign-in subject    |
| `slack`  | the Slack user id      |
| `email`  | the lowercased address |

An identity with no principal has been seen but not linked.

## Rules

1. **A handle that acts gets a principal.** When an unknown handle signs in or sends a message, QM first tries the
   email match below; otherwise it creates a principal (just a row) and attaches the identity.
2. **Auto-link by email.** An identity carrying an email attaches to the principal that owns the `email` identity for
   that address. Email identities are written only by admins or by the deployment (`PUT
/v1/admin/principals/:principalId/emails`); people cannot add their own. An address belongs to at most one
   principal. Names are never matched. Auto-links record `linked_by = auto:email` and the address as evidence.
3. **Linking** sets an identity's principal. The self-serve "connect Slack" flow and `POST /v1/admin/identities/link`
   call the same function, and neither has a direction or a main account. If the identity already belonged to another
   principal with history, the two principals are combined.
4. **Combine** (`POST /v1/admin/principals/combine` with `keep` and `drop`) re-points every reference from `drop` to
   `keep` in one transaction and deletes `drop`. Singleton clashes keep `keep`'s value; `drop`'s memory revisions are
   appended after `keep`'s. The columns it walks are listed in `src/identity/principal-refs.ts`, and
   `test/principal-refs.test.ts` fails when a schema adds a principal-shaped column without registering it.
5. **Unlink** (`POST /v1/admin/identities/unlink`) clears one identity's principal. Its next action follows rule 1.

Identity changes are portal-only for agents: an agent cannot decide which sign-ins belong to one person.

## Upgrading an existing deployment

Deployments that predate principals run the one-time migration with every core stopped:

```sh
DATABASE_URL=... node scripts/migrate-identities.mjs          # dry run: per-table rewrite counts
DATABASE_URL=... node scripts/migrate-identities.mjs --apply  # writes, in one transaction
```

It groups existing principal ids (joined by the old `principal_links` table and by Slack directory rows), creates a
principal and identities for each group, rewrites every registered column and durable-map row to the UUID, merges
notebooks, and drops `principal_links`. Each touched table is first copied to `identity_premigration_<table>`.
