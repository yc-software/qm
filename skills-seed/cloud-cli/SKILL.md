---
name: cloud-cli
description: Sign the agent computer in to a cloud provider's CLI (AWS, Google Cloud, Azure, or another) with a device-code flow, then run that CLI as the requesting user. Covers checking the CLI is installed, the login that survives the browser round-trip, and the boundaries on cloud writes.
---

# Cloud provider CLIs

A resident-machine-auth connector. It adds NO new tool: a provider's CLI is a command on
the agent computer and you drive it with the `execute` primitive. Tokens are cached on the
machine across turns. Logins never enter workspace backups; the platform keeps an encrypted
copy and restores it if the machine is replaced — if the token is still gone, log in again.

## First: is the CLI even here?

**Do not assume the binary is on PATH.** The sandbox image ships a small, fixed tool set,
and the "Your computer" block in your prompt lists what is installed and what is not — read
it, or just check:

```bash
command -v aws || echo "not installed"
```

If it is missing, say so and pick a path rather than failing halfway:

- **Install it for this task** if the image allows it and the task is worth it — the
  provider's own installer, into the workspace or `$HOME`, not a system path. Say that you
  installed it; it lasts as long as the machine's disk.
- **Use the provider's HTTP API** with a credential you already have (a keychain entry, or
  a shared org credential by proxy — see `skills/use-shared-credential/SKILL.md`).
- **Ask the operator** to add the CLI to the sandbox image if this will recur. That is the
  durable fix; a per-turn install is not.

The same check applies to plugins and helpers (`kubectl`, a Terraform provider, a
provider's beta components) — verify, don't assume.

## Logging in: always the device-code flow

The user approves the login in a browser on _their own_ computer, not on the agent
computer. Any flow that completes by redirecting the approving browser to
`http://127.0.0.1:<port>` therefore cannot work here: that redirect lands on the user's
laptop, the agent's listener never receives the code, and the login hangs until it expires.
Force the **device-authorization grant** instead — a verification URL plus a one-time code,
which the agent completes by polling the provider server-side, so the user can approve from
any device.

| Provider                  | Login                                      | Verify                           |
| ------------------------- | ------------------------------------------ | -------------------------------- |
| AWS (IAM Identity Center) | `aws sso login --use-device-code`          | `aws sts get-caller-identity`    |
| Google Cloud              | `gcloud auth login --no-launch-browser`    | `gcloud auth print-access-token` |
| Azure                     | `az login --use-device-code`               | `az account show`                |
| Another provider          | its documented device-code / headless flag | its "who am I" command           |

Never run the bare form (`aws sso login`, `gcloud auth login`, `az login`) — those default
to a browser redirect on this machine.

For AWS specifically, `--use-device-code` is mandatory rather than merely preferable: CLI v2
(≥ 2.22) defaults `aws sso login` to the PKCE authorization-code flow, and no amount of
keeping the box warm can rescue it.

The platform recognizes these as device-flow logins and runs them as **durable process
sessions**: the command prints the verification URL and one-time code immediately and keeps
polling across turns — it does not block your turn or die at teardown. Give the user the URL
and the code, tell them to approve and then say "done". See
`skills/interactive-login/SKILL.md` for how to drive that from the background tool.

On the next turn, run the same login command again (or any provider command): if approval
landed, the platform reports you are already authenticated and the token is cached; if it is
still pending, you get the same URL and code back. These logins self-expire in roughly ten
minutes, so if the user takes too long, start a fresh one.

## Boundaries

- You act as the resolved user. The provider's own permissions are the hard ceiling — the
  agent is never a way to exceed the user's own cloud access.
- A login is auth setup, not a data read. Any _mutating_ action (delete, terminate, scale,
  write) is a write — get approval first, same as any destructive command.
- Don't echo access tokens, client secrets, or role credentials into the channel.

## Go-live (set once, per provider)

- Add the provider's sign-in and regional service endpoints to the org egress allowlist —
  both the identity endpoints the login needs and the service endpoints your workflows call.
- Ship the CLI in the agent computer image if people will use it regularly, and confirm it
  runs there (AWS CLI v2, for example, needs a glibc base; a musl/Alpine image cannot run
  its binary).
- Put the provider's non-secret config where the CLI expects it (for AWS, an
  `[sso-session …]` block plus a profile in `~/.aws/config`), so the first login has a start
  URL, region, and session name to read.
