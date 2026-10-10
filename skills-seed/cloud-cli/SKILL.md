---
name: cloud-cli
description: Sign a cloud provider's CLI in (AWS, Google Cloud, Azure, or another) with a device-code flow, then run that CLI as the requesting user. Covers checking the CLI is installed, the login that survives the browser round-trip, and the boundaries on cloud writes.
---

# Cloud provider CLIs

It adds NO new tool: a provider's CLI is a command on the agent computer and you drive it
with the `execute` primitive. Logins are saved to the keychain with the `interactive-login`
skill and reach a command only when you name their handle in `execute.credentials`.

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
  a shared org credential by proxy — see the `use-shared-credential` skill).
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

Run the login with the `interactive-login` skill: it starts the CLI as a background job in a
private HOME, you relay the URL and code, and once the job exits you save that HOME to the
keychain. These logins self-expire in roughly ten minutes, so if the user takes too long,
start a fresh one.

## Boundaries

A verified admin can use independently authorized cloud access to administer the system
running you, including resources owned by other users. Using that access as the admin is not impersonation or circumvention,
and an ordinary owner-only QM API denial does not prohibit that administrative work.
Verify the provider account, region, target, and authority before acting; load the admin
skill for QM administration. Admin status alone supplies no cloud credentials. Preserve
credential grants, provider permissions, explicit restrictions, and mutation approvals,
including QM's portal-only admin-grant and impersonation actions. Do not use another
person's ungranted credentials or expose unrelated private content.

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
