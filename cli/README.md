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

On AWS, `up` snapshots the RDS instance under the deploy lease before its first
mutation, names the snapshot after the deployment manifest it precedes, and
records it in that manifest. `rollback` restores code and configuration only,
so it prints that snapshot as the matching data restore point
(`aws rds restore-db-instance-from-db-snapshot`). Pre-deploy snapshots are
pruned to a bounded count; `aws.predeployDbSnapshot: false` opts out.

`sandbox build` is a local validation build. `sandbox publish` pushes through the
configured OCI registry, resolves the image and base digests, records the base pin in
the config and the image pin in the config (docker/fly) or the durable AWS deployment
manifest, syncs the durable deployment layer when core is reachable, and repoints a
running Fly or AWS core. On AWS it requires `sandbox.backend: "sprites"` and, before
building anything, an existing deployment manifest and no `sandbox.image` override —
that override only seeds the first `qm up` and must be removed afterwards. Every
ordinary `up` also syncs the layer.

Auto uses its built-in model classifier unless `qm.config.jsonc` declares one
`securityScreen` proxy with a provider label, HTTPS endpoint, and `shadow` or
`enforce` rollout. The proxy token is routed separately through
`secretEnv.core.SECURITY_SCREEN_PROXY_TOKEN`.

## Commands

```text
init [dir] [--org id] [--target docker|fly|aws]
setup [dir]
password <email>
check [--json] [--live]
doctor
infra render|build-image|delete-image|delete-task-definitions
conformance [dir] [--static]
plan
up [--yes] [--build-from[=repo]] [--image-label label]
slack render
outputs [--json]
proof scope-key <scope-id>
secrets push [--from file]
status
logs [service] [-f] [--tail n]
down [--purge]
rollback [--to revision-or-sha]
sandbox build [--from image] [--tag tag] [--dry-run]
sandbox publish [--from image] [--app registry/repo] [--tag tag] [--dry-run]
```

All deploy commands accept `--config`, `--env-file`, and `--sandbox-dir`. `dev` remains
the contributor worktree loop and is separate from the portable deployment contract.

## Password sign-in without email delivery

With the built-in `auth` service enabled, set `env.auth.AUTH_LOGIN_METHOD` to
`"password"` in `qm.config.jsonc`. The default is `"email"`. Password mode needs
neither Resend nor SMTP; `AUTH_EMAIL_TRANSPORT` can be removed. Existing optional
email credentials remain available to core for external invitations.

Run `qm setup` to collect and confirm passwords for the first administrators in
`ADMIN_GRANTS`, or `qm password admin@example.com` to provision or reset an
account. The operator must verify each identity first: this flow has no public
signup, email verification, or emailed password reset. Passwords contain 15 to
128 characters, including spaces and Unicode; hidden input is never trimmed.
Only salted scrypt hashes are saved as `AUTH_PASSWORD_HASHES` in the private
`.env`, and that secret is delivered only to `auth`.

`qm password` grants no membership or administrator access. Add permanent members
explicitly to `AUTH_ALLOWED_EMAILS` or `AUTH_ALLOWED_EMAIL_DOMAIN`, and use the
normal external invitation flow for temporary users. Keep the administrator seed
in `ADMIN_GRANTS`. Before resetting a cloud account, load the complete current
`AUTH_PASSWORD_HASHES` map into `.env` or export it in your shell; the command
preserves that map and never fetches cloud secrets. Run `qm up` to apply changes on
Docker. On Fly or AWS, run
`qm secrets push` first, then `qm up`. Password changes affect new logins;
existing portal sessions continue until they expire.

## Package contract

The `@yc-software/qm/contract` export is the supported programmatic surface for
conformance tests. It exposes the contract version, parsing/rendering
functions, and provider ids without registering arbitrary runtime plugins.
Incompatible directory
changes increment the contract major; optional fields may be added within a
major.

The package has no runtime dependencies. It shells out to Docker with Buildx, Flyctl,
the AWS CLI, and Git. Terraform is operator-run against the module generated by `init`.
