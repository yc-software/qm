# The software factory loop

The factory is a loop with `surface: "factory"`. Each item is a Linear ticket. The loop runs a
coding-agent wrapper inside a sandbox, and the wrapper works the ticket to a pull request against
the configured repository. The loop then reads the forge to judge whether the pull request has
converged, and ships it by marking it ready and moving the ticket.

## Prerequisites

Three org-scoped service credentials in the keychain. The slugs are fixed.

| Slug                | Holds                | Scope it needs                                                     |
| ------------------- | -------------------- | ------------------------------------------------------------------ |
| `factory-linear`    | A Linear API key     | Read and write issues, comments, and states on the configured team |
| `factory-github`    | A GitHub token       | Push and pull requests on the publish project                      |
| `factory-anthropic` | An Anthropic API key | Model calls made by `claude` inside the sandbox                    |

A missing or disabled credential fails the fire before any sandbox work, naming the slug.

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
five-minute cron is fifteen minutes: put the three credentials in the keychain before Apply, and
re-enable a quarantined loop from the Loops page.

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

## Security posture

The wrapper runs as root inside the sandbox with `IS_SANDBOX=1`, which lets `claude` run with
`--dangerously-skip-permissions`. The model therefore executes tool calls with no permission gate,
and its process environment holds the three credentials above. The blast radius is the sandbox
plus whatever those three tokens can reach: the configured Linear team and the publish project.
Scope the tokens accordingly. Admin-supplied commands in the config
also run in that environment, so the admin console is the trust boundary.

Secrets never appear in a command string or in the run's recorded reason. The bootstrap
authenticates through `GIT_CONFIG_*` environment entries, which git does not write to disk.

## Ownership

The loop is owned by the admin who first applied the config. Administration of an org-scoped loop
by other org admins is a known gap.
