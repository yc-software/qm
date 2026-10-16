# `qm`

The standalone deployment CLI for QM. The normative directory schema,
security guarantees, target behavior, and lifecycle are in
[`docs/deploy-directory.md`](../docs/deploy-directory.md). `qm init` materializes
the agent-consumable package runbook into the deployment repository.

```bash
npm exec --yes --package=@yc-software/qm@latest -- \
  qm init . --org acme --target aws
npm install
npm exec qm -- check
npm exec qm -- infra render
npm exec qm -- doctor
npm exec qm -- infra build-image
npm exec qm -- plan
npm exec qm -- up --yes
npm exec qm -- check --live
```

This package is published to npm as `@yc-software/qm`, with npm provenance attesting the
building workflow. A release is one dispatch of `.github/workflows/release.yml` from
`main`: it signs and pushes the first-party images, publishes the package pinning their
digests, and then tags `v<version>` and creates the GitHub release with the resolved
digests attached. Each release picks its own version: a patch bump past the latest released version, or
`cli/package.json`'s version when a PR raised it higher (for a minor or major bump); a
tag that already exists stops the release rather than moving. The checked-in image manifest is a sentinel that
a deployment overrides with real digests. The packed-artifact test exercises the consumer
path locally.

The CLI deploys long-running QM services; it is not the runtime. Docker runs
them locally, Fly runs them as Fly apps with Fly Machines for agent computers, and AWS
runs digest-pinned tasks on ECS Fargate (amd64 by default for first-party services) with Lambda MicroVM agent computers.

When upgrading an AWS source deployment that previously relied on the ARM64 default,
set each existing workload's `architecture: "arm64"` explicitly until rebuilding
its image for another platform. Secret rotation refuses a task-platform change
before uploading secrets. New release candidates record their workload architectures;
legacy source-built first-party candidates without that record require an explicit
architecture matching the image, or regeneration with the current CLI. Candidate
deployment and migration reject platform mismatches before accessing AWS.

## Deployment directory

```text
qm.config.jsonc
package.json
package-lock.json
deployment.md
.codex/skills/deploy-qm/
.env.example
.env
slack-app-manifest.yml
slack-sso-manifest.yml
sandbox/
  tools/<id>/tool.json
  tools/<id>/<binary>
  skills/<id>/SKILL.md
  Dockerfile
plugins/<name>/Dockerfile
infra/
```

`qm.config.jsonc` is committed and contains no secret values. `.env` is ignored.
`package.json` pins a registry-installed CLI package at the exact version that
scaffolded the directory — `contract: 1` is only the compatibility floor — so
every checkout resolves the same interpreter; upgrade the pin deliberately.
Explicit local, Git, or URL source overrides and npm alias overrides are preserved for development.
`cd` into it and the DEPLOY commands act on it; `--config` / `--env-file` / `--sandbox-dir` relocate
a piece (e.g. several deployments sharing one `sandbox/`). `check` validates the config,
computed secret names, tools, skills, and plugins without network access; `up`, `plan`, and
`sandbox build` run the same checks first. `doctor` verifies external prerequisites read-only.
`plan` renders the deployment; AWS mutation requires `up --yes`.

For a single-host Docker deployment, `sandbox.backend: "local"` runs each agent
computer in its own container. `qm up` builds the local runtime from the CLI's
pinned sandbox base, mounts the host Docker socket into trusted core, and connects
core to each sandbox's private network. An explicit `sandbox.image` uses that
runnable local image instead.

On AWS, `up` verifies under the deploy lease that RDS point-in-time recovery
is current (its `LatestRestorableTime` must lag by at most
`QM_AWS_DB_MAX_RESTORE_LAG_MS`, default 10 minutes) and records the pre-deploy
timestamp in the deployment manifest it precedes. `rollback` restores code and
configuration only, so it prints that timestamp as the matching data restore
point (`aws rds restore-db-instance-to-point-in-time`);
`aws.predeployDbSnapshot: false` opts out.

On AWS, `up` waits for every rolling service to reach `COMPLETED` with a single
deployment, polling until `QM_AWS_ROLLOUT_DEADLINE_MS` (default 20 minutes); a
timeout rolls the changed services back. ECS stops the old tasks once they exit
or their `stopTimeout` elapses (core drains for `SHUTDOWN_DRAIN_MS`, 10 s by
default), and a turn cut off there resumes on the new tasks. Core images older
than this release protect their task while a turn runs, so the first `qm up`
that replaces them cannot finish before their longest in-flight turn ends
(protection expires after 60 minutes at most); run that one deploy with a
longer deadline or when no long turn is in flight.

AWS deployments can opt into durable background ownership with
`aws.backgroundWorkControl: true`. The CLI allocates a unique
`BACKGROUND_DEPLOYMENT_ID` for each replacement core deployment and records it in
the deployment manifest. A no-op deployment and automatic ECS task replacement keep
that identity; an explicit core restart allocates a new one. Pending preparation
is persisted before ECS changes, and an ambiguous previous deployment must be
reconciled before another identity can be allocated.

Control requests require both `CORE_SIGNING_SECRET` and a distinct
`DEPLOYMENT_CONTROL_SECRET` of at least 32 characters. The control secret is
restricted to core. One shared record names the deployment that owns background
work; a core process with a configured identity admits work only while that
record names its deployment, and `BACKGROUND_WORK_ENABLED` is ignored there.

The exported `awsBackgroundWorkBootState` reads the exact manifest core task to
return its recorded boot flag and optional deployment identity. It returns
`undefined` only without a recorded core task, and rejects missing or ambiguous
boot flags or identities.

The exported `awsBackgroundWorkStatus(config, configDir, candidatePath?)` proves
the stack's exact healthy core task set and reads the owner record through the
stack's own API, returning the responder's `ownerDeploymentId`, `setAt`, `setBy`,
and whether the responding process is currently active. The exported
`awsSetBackgroundWork(config, configDir, enabled, candidatePath?, expected?)` sets
the owner record to the stack's identity (or clears it when `enabled` is false)
without restarting ECS tasks, then polls until every core task of the stack has
reported matching activity. Passing `expected: { ownerDeploymentId }` refuses the change
if the owner differs from what the caller last observed. A demotion refuses to
clear a different deployment's ownership.

The exported `awsBackgroundWorkCapacity(config, configDir, candidatePath?)` proves
that an inactive controlled stack is currently reusable. It requires another
owner, stable native deployments and exact task inventories for every workload,
and resolved deployment preparation. It never changes deployment state. The
result binds the manifest and deployment identities, the owner, workload task
definitions, native deployment IDs, and task ARNs. A release coordinator can
combine both snapshots with immutable candidate provenance and compare them
again under its production lock before any mutation. This is a point-in-time
check, not a reservation: intervening maintenance or task replacement
invalidates the proof and must block promotion.

Live checks use the owning deployment's authenticated canary endpoint to verify a
real model reply, session persistence, generated title, error records, session
cleanup, and database catalog health. The CLI confirms the stack owns background
work and is active before and after the check, and requires a final success bound
to the request and responding process; heartbeats alone do not count. An uncertain
result never triggers an automatic replay or fallback. Legacy deployments retain
the Fargate canary, and a controlled stack that does not own background work uses
that same path.

Replacing or rolling back a controlled stack's core tasks requires that the stack
is not the current owner: hand ownership to the other stack first. Processes that
lose ownership stop claiming within their poll interval (at most their ten-second
validity window) and finish admitted work under their leases; ECS task
replacement then drains them through `SIGTERM`. `qm down` is not guarded: if the
record still names a stack that has no tasks, set the live stack active to
recover.

Core secret uploads defer activation to a subsequent staged `up --restart core`.
The generic upload path refuses changes to either control credential while a
controlled deployment is recorded, because replacing credentials before coordinating
all running processes would break ownership control. Legacy AWS deployments keep
the task replacement path when ownership control is not configured.

Batch operators can set `QM_DEPLOY_PROGRESS_FILE` to a new absolute file path and
`QM_DEPLOY_PROGRESS_TOKEN` to a unique attempt identifier for candidate `up --yes`.
After all forward service updates have been submitted, the CLI atomically creates
a private JSON receipt with `phase: "monitoring"`, `token`, `orgId`, and `targets`
(the selected workload-to-task-definition mapping). It then continues health
checks, manifest recording, and rollback under the deployment lease. This receipt
only permits the batch runner to release a submission slot; the CLI exit status
still determines success. Use a fresh path and token for every attempt. Missing
receipts must keep the submission slot occupied until the CLI exits.

`sandbox build` is a local validation build of the sandbox layer image. At runtime
sandboxes boot their platform's stock image; tools and skills arrive through the
deployment-layer sync, which every ordinary `up` performs.

Content screening is off by default. Set `securityScreen: { "mode": "observe" }`
to record classifier verdicts without acting on them, or `"enforce"` to quarantine
flagged content. The classifier is the built-in model unless `"classifier": "proxy"`
names an external screener with a provider label and HTTPS endpoint; route its token
through `secretEnv.core.SECURITY_SCREEN_PROXY_TOKEN`.

## Commands

```text
init [dir] [--org id] [--target docker|fly|aws]
check [--json] [--live]
doctor
infra render|build-image|delete-image|delete-task-definitions
conformance [dir] [--static]
plan
up [--yes] [--build-from[=repo]] [--image-label label]
slack render
outputs [--json]
admin-login [--email admin@example.com]
proof scope-key <scope-id>
secrets push [--from file]
status
logs [service] [-f] [--tail n]
down [--purge]
rollback [--to revision-or-sha]
sandbox build [--from image] [--tag tag] [--dry-run]
```

## Administrator login without email

After deployment, run `qm admin-login` to print a single-use login URL valid for
five minutes. Open it and confirm the displayed administrator email. The command
uses the deployment's existing `PORTAL_SESSION_SECRET` and the email in
`ADMIN_GRANTS`; if several admins are configured, select one with `--email`.
QM checks that the selected account still has `org_admin` access when the link
is redeemed. The command creates no account or role grant.

Run it from the deployment directory with its `.env`, or use `--config` and
`--env-file`. Inside a running deployment without a config file, supply
`PORTAL_PUBLIC_URL`, `PORTAL_SESSION_SECRET`, and `ADMIN_GRANTS` through its
environment. The CLI prints only the URL, which is a temporary login credential;
do not publish it or put it in shared logs.

`qm setup` offers email setup separately. Skip it to use administrator login
without Resend or SMTP. For ordinary users before email is ready, the broker can
accept passwords: hash one with `node plugins/auth/src/hash-password.ts
user@example.com` and store the output with `qm secrets set AUTH_PASSWORD_USERS`.
This is meant for onboarding; switch to email links or an identity provider
afterwards. To enable ordinary email login later, rerun `qm setup`
and configure the selected transport's complete credential set and sender,
then push secrets and redeploy. Missing email credentials disable email sign-in;
QM and `qm admin-login` remain available, even if a sender is still configured.

Deployment commands accept `--config`, `--env-file`, and `--sandbox-dir`;
`admin-login` uses only `--config` and `--env-file`. `dev` remains
the contributor worktree loop and is separate from the portable deployment contract.

## Package contract

The `@yc-software/qm/contract` export is the supported programmatic surface for
conformance tests. It exposes the contract version, parsing/rendering
functions, and provider ids without registering arbitrary runtime plugins.
Incompatible directory
changes increment the contract major; optional fields may be added within a
major.

The package has no runtime dependencies. It shells out to Docker with Buildx, Flyctl,
the AWS CLI, and Git. Terraform is operator-run against the module generated by `init`.
