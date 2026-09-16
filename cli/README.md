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
runs digest-pinned ARM64 tasks on ECS Fargate with Lambda MicroVM agent computers.

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
`package.json` pins the CLI package at the exact version that scaffolded the
directory — `contract: 1` is only the compatibility floor — so every checkout
resolves the same interpreter; upgrade the pin deliberately.
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

AWS deployments can opt into durable background ownership with
`aws.backgroundWorkControl: true`. Deploy protocol-capable core images to every
participating stack before bootstrapping ownership. The CLI allocates a unique
`BACKGROUND_DEPLOYMENT_ID` for each replacement core cohort and records it in the
deployment manifest. A no-op deployment and automatic ECS task replacement keep
that identity; an explicit core restart allocates a new one. Pending preparation
is persisted before ECS changes, and an ambiguous previous deployment must be
reconciled before another identity can be allocated.

Control requests require both `CORE_SIGNING_SECRET` and a distinct
`DEPLOYMENT_CONTROL_SECRET` of at least 32 characters. The control secret is
restricted to core. Configuring an identity preserves the legacy background flag
until explicit bootstrap verifies every participating task. The exported
`awsBootstrapBackgroundWork` adapter accepts all peer configurations and an exact
desired deployment identity, or `null` to start paused. It refuses missing cohorts
and inconsistent durable membership.

The exported `awsBackgroundWorkBootState` reads the exact manifest core task to
return its recorded boot flag and optional deployment identity. It returns
`undefined` only without a recorded core task, and rejects missing or ambiguous
boot flags or identities. Deployment wrappers can preserve the boot environment
while changing durable ownership independently.

The exported `awsBackgroundWorkCapacity(config, configDir, candidatePath?)` proves
that an inactive controlled stack is currently reusable. It requires another
owner, fully drained current membership, stable native deployments and exact task
inventories for every workload, resolved deployment preparation, and explicitly
disabled protection on every current core task. It never changes task protection
or deployment state. The deploy role needs `ecs:GetTaskProtection` on its tasks.
The result binds the manifest and deployment identities, ownership generation,
workload task definitions, native deployment IDs, task ARNs, and protection proof.
`awsBackgroundWorkStatus` also returns the current manifest ID for an active-owner
proof. A release coordinator can combine both snapshots with immutable candidate
provenance and compare them again under its production lock before any mutation.
This is a point-in-time check, not a reservation: intervening maintenance or task
replacement invalidates the proof and must block promotion.

Live checks use the active ownership cohort's authenticated canary endpoint to
verify a real model reply, session persistence, generated title, error records,
session cleanup, and database catalog health. The CLI proves the exact healthy
task cohort and ownership generation before and after the check. It requires a
final success bound to the request and responding task; heartbeats alone do not
count. An uncertain result never triggers an automatic replay or fallback.
Legacy deployments retain the Fargate canary. A controlled deployment uses that
same path only when a successful ownership read proves bootstrap is disabled or
another cohort owns background work.

Once bootstrapped, background mode changes use generation-checked ownership
requests without restarting ECS tasks. Activation waits for prior owners to stop
claiming and every expected task to finish activation. Pausing stops new claims;
in-flight turns can continue draining. Replacing or rolling back the active core
cohort requires an explicit pause or handover and proof that every member has
drained first. A demotion refuses to pause a different current owner. Unresponsive members are never
assumed dead: `awsRetireBackgroundWorkMembers` requires exact instance, task ARN,
and generation identities plus ECS evidence that each task stopped. This recovery
is also available before bootstrap for stopped legacy members.

Core secret uploads defer activation to a subsequent staged `up --restart core`.
The generic upload path refuses changes to either control credential while a
controlled cohort is recorded, because replacing credentials before coordinating
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

Model screening is off by default. Set `securityScreen: { "backend": "model" }`
to opt in, or configure a `securityScreen` proxy with a provider label, HTTPS
endpoint, and `enforce` rollout to use an external screener without model fallback.
The optional `shadow` rollout explicitly runs the model classifier and compares
the proxy verdict. Route the proxy token through
`secretEnv.core.SECURITY_SCREEN_PROXY_TOKEN`.

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
without Resend or SMTP. To enable ordinary email login later, rerun `qm setup`
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
