---
name: 1password
description: Fetch a credential out of a teammate's 1Password vault with the op CLI at the moment a task needs it — after their `1password` keychain credential (a vault-scoped service-account token) is in your shell. Covers getting the token, installing op, finding the right item, reading one field, and secret hygiene.
---

# 1Password: fetch credentials when needed

A teammate who connected 1Password has a `1password` entry in their keychain. That entry is
NOT a single secret — it is a **service-account token scoped to a vault they chose to share
with agents**. With it in your shell as `OP_SERVICE_ACCOUNT_TOKEN`, the `op` CLI reads items
from that vault, live from 1Password, at the moment of use. Nothing from the vault is stored
on the platform, so an item the owner rotates or revokes in 1Password changes for you
instantly too.

## Getting the token into your shell

The same rules as every keychain credential — your keychain manifest is the source of truth:

- In the owner's own DM it is already in your environment.
- In a shared conversation it needs a grant from the owner. A standing grant injects it on
  every turn; otherwise run the `use.command` the grant response gives you and work in that
  same shell.

Never ask anyone to paste the token — or any vault item — into chat.

## Using it

Check for the CLI first; if missing, install it into `$HOME`, never a system path
(1Password's install page: https://developer.1password.com/docs/cli/get-started/):

```bash
command -v op || echo "not installed"
```

Then fetch only what the task needs: `op vault list` shows what the token can read,
`op item list` finds the item, and `op read` loads ONE field.

```bash
op vault list --format json
op item list --vault "<vault>" --format json
op read "op://<vault>/<item>/<field>"
```

Prefer feeding the value straight to the command that needs it, so it never lands in a file
or in output:

```bash
STRIPE_API_KEY="$(op read 'op://Agents/Stripe/credential')" ./deploy.sh
```

## Boundaries

- Fetch the single field a task needs, when it needs it. Never dump whole items or vaults,
  never echo or log a value, and never copy one into the workspace, a file backup, or chat.
- If an item you need is not in the shared vault, ask the owner to add it in 1Password (or
  register it with a secret-drop link) — do not hunt for another way in.
- Stay within the grant's purpose, like any other credential use.
