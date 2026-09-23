# The software factory loop

The factory is a loop with `surface: "factory"`. Each item is a Linear ticket. The loop runs a
coding-agent wrapper inside a sandbox, and the wrapper works the ticket to a pull request against
the configured repository. The loop then reads the forge to judge whether the pull request has
converged, and ships it by marking it ready and moving the ticket.

## Prerequisites

Linear access is not a pasted credential. Every fire resolves the loop owner's Linear connector
token for `api.linear.app`, so an org admin must have registered the Linear OAuth client and the
loop owner — the admin who applied the config, see "Ownership" — must have connected Linear once
through the connector flow. Without that grant the fire fails before any sandbox work with
`linear: the loop owner has not connected Linear`. Linear's OAuth scopes are not per-team: the
connector's `read` and `write` grant covers every team the owner can reach, not just the
configured one.

GitHub access is not a pasted credential either. Every fire resolves the loop owner's GitHub connector
token for `api.github.com`, so an org admin must have registered the GitHub OAuth client and the
loop owner — the admin who applied the config, see "Ownership" — must have connected GitHub once
through the connector flow. Without that grant the fire fails before any sandbox work with
`github: the loop owner has not connected GitHub`. The connector's `repo` and `read:org` scopes
are what the run can reach on the forge.

Model calls made by `claude` inside the sandbox use core's own Anthropic configuration —
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, or the
`CLAUDE_AUTH_CREDENTIAL` keychain credential — and not a pasted secret. A deployment with none of
them fails the fire with `model auth: core has no Anthropic credential configured`.

## Configuration

The Software factory card in the admin console, at org scope, writes the factory config and
creates the loop on Apply. Applying again finds the same loop. Clear removes the config and leaves
the loop and its cron, whose every fire then fails with `factory_config_missing`; disable or
delete the loop from the Loops page to stop it.

| Field                                                  | Meaning                                                                                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forge`, `publishProject`, `targetBranch`              | Where pull requests open                                                                                                                              |
| `repoCloneUrl`, `repoSetupCmd`                         | The subject repository and the command run in it before work starts                                                                                   |
| `linearTeamId`                                         | The team whose `Auto-Triage` tickets the loop enumerates                                                                                              |
| `sourceAppDirs`, `sourceTestRe`                        | Which paths the run may change and which files count as tests                                                                                         |
| `verifyTestsCmd`, `verifyTestFileCmd`, `verifyLintCmd` | The verification commands                                                                                                                             |
| `proofStartCmd`, `proofBaseUrlCmd`                     | Optional browser proof: bring the app up and print its URL                                                                                            |
| `bugbotRequired`                                       | Whether convergence needs a Bugbot review of the exact head; the loop enforces it, the wrapper-side check is off until a Bugbot user id is configured |
| `followupsEnabled`                                     | Whether the run may file follow-up tickets                                                                                                            |

Apply also gives the loop a cron that fires it every five minutes, so tickets are picked up
without anyone asking. Applying again reuses that cron. Fire it early from the Loops page, or
through `POST /v1/loops/:id/fire`. Three consecutive failed fires quarantine the loop, which on a
five-minute cron is fifteen minutes: connect the loop owner's Linear and GitHub before Apply, and
re-enable a quarantined loop from the Loops page. A fire that lands while a run is still working
claims nothing and records `deferred: <ticket> is still in progress` — the factory works one
ticket at a time, and the queued tickets are picked up by the first fire after the run ends.

## What a run does

1. Preflight probes the sandbox for `bash git gh jq curl node npm claude`.
2. Bootstrap fetches this repository at depth 1 into `/workspace/qm-source` in the sandbox, at
   the full commit this core was built from (`GIT_SHA`), so the wrapper under `factory/` and the
   loop always come from the same commit. A core with no build commit, or an abbreviated one,
   fetches `main`. A warm sandbox re-fetches instead of re-cloning.
3. The wrapper starts from `/workspace/qm-source/factory/.claude/io-coding-agent-js.sh` with
   the subject repository as its working directory. It clones the subject repository, runs the
   setup command, and drives the ticket through understand, plan, implement, verify, review,
   proof, and ship.
4. The loop parses the wrapper's stdout for the pull request and reads the forge until CI is green
   and no review blocks it. A run that ends without a pull request returns the item to work with
   the wrapper's last diagnostic lines as its reason, secrets masked.

## Sandbox size

The sandbox is created at the Sprites account default — 8 GB of RAM, no swap, and an overlayfs
root that refuses a swapfile. Review and Proof run three review agents at once, and a UI ticket
also boots core, the web UI, the portal and Chromium on the same machine, which peaks above that
and gets the VM OOM-killed; the wrapper disappears with exit 137 and the run's work is lost. Set
`SPRITES_RAM_MB` and `SPRITES_CPUS` to size it — `SPRITES_RAM_MB=16384` and `SPRITES_CPUS=4` on
the factory deployment. Both are deployment-wide and apply to every Sprite that deployment
creates. An existing Sprite keeps the size it was created with, so an operator deletes it and the
next run provisions it at the configured size.

## Security posture

The wrapper runs as root inside the sandbox with `IS_SANDBOX=1`, which lets `claude` run with
`--dangerously-skip-permissions`. The model therefore executes tool calls with no permission gate,
and its process environment holds the loop owner's Linear connector token, the loop owner's GitHub
connector token, and core's model credential. The blast radius is the sandbox plus whatever those
tokens can reach: everything the owner's Linear grant reaches under the connector's `read` and
`write` scopes, everything the owner's GitHub grant reaches under the connector's `repo` and `read:org` scopes,
and core's Anthropic account. Admin-supplied commands in the config
also run in that environment, so the admin console is the trust boundary.

Secrets never appear in a command string or in the run's recorded reason. The bootstrap
authenticates through `GIT_CONFIG_*` environment entries, which git does not write to disk.

## Ownership

The loop is owned by the admin who first applied the config. Administration of an org-scoped loop
by other org admins is a known gap.
