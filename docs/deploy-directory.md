# Deployment directory contract

Contract v1 makes a QM deployment a committed, portable directory. The `qm` CLI is the only interpreter of that directory: it validates the same inputs it uses to render containers, task definitions, secret routing, and the agent-computer layer.

## Layout

`package.json` pins the `@yc-software/qm` deployment engine at the exact version that scaffolded the directory, so the directory records which CLI interprets it rather than drifting with whatever version an operator has installed; `contract: 1` remains only the compatibility floor. `package-lock.json` records the installed artifact. `qm.config.jsonc` is the deployment config. `deployment.md` and `.codex/skills/deploy-qm/` are materialized package assets an operator can hand to an agent. `sandbox/` adds tools and skills to agent computers; `plugins/` adds services; `.env.example` documents the computed secret names; `.env` supplies local values and is never committed. `qm init` writes `slack-app-manifest.yml` for the optional Socket Mode bot. It also writes `slack-sso-manifest.yml` only when the portal is configured to use Slack OpenID. `qm slack render` refreshes the applicable manifests after `publicUrl` changes, and `qm outputs` returns their creation links and the web coordinates. `qm init --target aws` also vendors the reference `infra/` Terraform module and its derived `terraform.tfvars`; the copy belongs to the deployment after generation. Init never overwrites an existing deployment config.

The sandbox layout is:

```text
sandbox/
  Dockerfile
  tools/<id>/tool.json
  tools/<id>/<binary>
  skills/<id>/SKILL.md
  skills/<id>/<text assets>
```

The Dockerfile is optional when every declared binary is present in its tool directory. Skill assets delivered through the deployment-layer API are text in v1; binaries belong in the sandbox image.

## Configuration

The root object requires `contract: 1`, `orgId`, `publicUrl`, `target`, and `services` including `core`. Docker and Fly also require `sandbox.app`. On AWS the sandbox substrate is an explicit choice: omitting the `sandbox` block runs named Lambda MicroVM images; declaring one requires `sandbox.backend` — `"sprites"` boots the operator-published layer image in `sandbox.app`, `"aws"` states the MicroVM default in the file. Unknown contract majors fail closed. `target` is `docker`, `fly`, or `aws`.

Common optional fields select the model, plugins, extra skill directories, per-service non-secret environment values, image overrides, sandbox settings, and an external security screen. `botName` (at most 31 characters, so the generated "`<botName>` SSO" app name fits Slack's 35-character cap) names the bot everywhere users see it — the generated Slack app manifests, the prompt identity, and sign-in pages — and `orgName` (at most 40) is how the bot refers to the organization; both default to neutral values and can be changed live from the Admin page's Branding card, which then takes precedence over the deployed values. `sandbox.backend` selects the aws-target sandbox substrate (see above); `sandbox.image` is the immutable rootfs pin used at boot; `sandbox.baseImage` records the digest-pinned build input; `sandbox.env` is non-secret runtime environment; `sandbox.secretEnv` lists org-wide secret names whose values are forwarded to every sandbox. `securityScreen` contains `backend: "proxy"`, a lowercase provider label, an HTTPS endpoint, and a `shadow` or `enforce` rollout. Its presence requires `secretEnv.core.SECURITY_SCREEN_PROXY_TOKEN`; absence keeps Auto on the built-in model classifier.

Fly requires `region` and `flyOrg`. AWS requires a 12-digit account, region, deployment label, ECS cluster, deploy-role ARN, Secrets Manager prefix, DNS-valid Cloud Map namespace, and an entry for every enabled first-party service and discovered plugin containing a unique valid ECR repository, a unique valid ECS service, and a valid Fargate CPU/memory combination. The cluster is constrained so every IAM, RDS, ALB, and related name derived by the reference module is valid. `imageLabel` identifies the complete deployment manifest used by rollback and live drift checks; the matching OCI/ECR tag is a convenience pointer. Workloads may also set `arm64`/`amd64` architecture, non-secret build arguments, or role ARNs. External prebuilt images must declare their architecture; source-built and built-in workloads use their platform default. Cloud Map names are the private workload addresses. The reference AWS module exposes CloudFront over HTTPS and restricts its HTTP ALB origin to CloudFront's managed origin prefix. With portal enabled, it is the ALB's sole target; access to private core, web, and admin surfaces requires signed portal identity. Without portal, only core is an ALB target. A real harness requires an HTTPS `publicUrl`.

`publicUrl` is the one public coordinate. The CLI derives the core, Slack, web, admin, and portal URL environment from it. Config `env` is for non-secret values only; secret-shaped keys are rejected.

## Security screen proxy

The proxy endpoint receives one or more HTTPS `POST`s per bounded classification with `content-type: application/json`, the routed token in `x-api-key`, redirects disabled, and this body:

```json
{
  "text": "untrusted content",
  "hook": "user_input",
  "metadata": {
    "surface": "webhook",
    "origin": "automation",
    "qm": {
      "request_id": "uuid",
      "input_index": 0,
      "chunk_index": 0,
      "chunk_count": 1
    },
    "provider-label": {
      "request_id": "uuid",
      "input_index": 0,
      "chunk_index": 0,
      "chunk_count": 1
    }
  }
}
```

`hook` is `user_input` or `tool_response`; metadata fields appear only when known. The chunk coordinates are also mirrored under the configured provider label so a direct provider endpoint can consume its own namespace without a built-in adapter. Inputs are capped at 16,000 characters and split into overlapping 1,600-character requests with at most two in flight per classification. All chunks share a request ID. A successful provider returns finite `score` and `threshold` numbers from zero through one plus an optional lowercase `primary_outcome` label:

```json
{
  "score": 0.91,
  "threshold": 0.7,
  "primary_outcome": "prompt_injection"
}
```

A chunk whose score is at or above its threshold resolves to Strict, and any Strict chunk makes the whole classification Strict. When chunks agree, the highest-scoring result supplies the diagnostics. The configured provider is an audit label and metadata namespace, not a built-in adapter name, so any service implementing this contract can be selected. Throttled requests retry with bounded backoff inside the classification deadline. Invalid responses, timeouts, redirects, and other provider errors are unavailable classifications: enforcement fails closed, while shadow mode leaves the built-in model authoritative and records the comparison. Shadow changes authority, not disclosure: it still sends the full screened content to the configured endpoint, so operators must trust that provider with external messages, files, and surface results.

## Secrets

First-party services publish a typed `SecretSpec` schema. The CLI combines the enabled services and feature predicates with plugin `secrets` and `sandbox.secretEnv` to form the computed secret set. That same schema determines which task receives each secret. Core validates its own required runtime secrets at production boot.

`init` renders the set as `.env.example`; that file has names and descriptions, never values, and is not an input to deployment. Operators place values in gitignored `.env`. Docker reads the file locally. `qm secrets push` uploads supplied operator-managed values to Fly secrets or AWS Secrets Manager without printing them. Terraform owns `DATABASE_URL` on AWS because it owns RDS. `doctor` treats missing and placeholder required values as failures and reports absent optional plugin secrets without blocking deployment.

## Tool descriptors

Only `id` is required. The remaining fields buy these runtime guarantees:

| Field                       | Guarantee                                                                                                                                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`                     | Human-readable name in resident-login status.                                                                                                                                                                                                                          |
| `advertise`                 | Added to the agent computer's installed-CLI list.                                                                                                                                                                                                                      |
| `hints`                     | Added to the model's deployment-tool guidance.                                                                                                                                                                                                                         |
| `auth.check`, `auth.reauth` | Merged into the resident-login connector registry.                                                                                                                                                                                                                     |
| `auth.credentialPaths`      | One `$HOME`-relative set of `{ path, kind }` entries drives resident capture, ephemeral linking, and device-flow persistence. Each entry explicitly declares `file` or `directory`; absolute paths and traversal are rejected, and `.ssh` warns.                       |
| `auth.splitEnv`             | Adds publish-time environment after all placeholders resolve. `{actingSlackUserId}` is the only v1 placeholder. It is trustworthy only where the surface or broker cryptographically binds the acting Slack identity; otherwise no acting identity should be supplied. |
| `egress`                    | Validated as host names and checked for dangerous wildcards. Runtime enforcement is not claimed in v1.                                                                                                                                                                 |
| `approvals`                 | Appended to the command-policy floor. A rule may deny or require approval for its own tool; it may never add an allow or loosen administrator policy.                                                                                                                  |
| `install.binary`            | Must be present in the layer or installed by its Dockerfile; the image build checks PATH.                                                                                                                                                                              |

Raw approval patterns must start with the canonical `\b<install.binary-or-id>\b` boundary and cannot use a top-level alternative, so every match begins with their own tool; nested alternatives after that prefix remain available. A `command` rule is safely anchored to that same effective binary by the CLI. Duplicate tool ids fail. Skills require `name` and `description` frontmatter.

Deployment-specific safety belongs here too. For example, an ambiently authenticated CLI declares a deny `approvals` rule for its login command, a `hints` entry telling the model not to log in, and its `auth.credentialPaths`; generic core carries no vendor-specific command exception or credential path.

## Delivery and pins

When `sandbox/` exists, every `up` sends its descriptors and complete text skill trees to source-authenticated `PUT /v1/deployment-layer`. Without `sandbox/`, `up` skips layer sync and leaves the deployed layer unchanged. Core validates submitted bundles again, stores them in Postgres table `deployment_layer`, versions them by a canonical SHA-256 content hash, records an audit event, hydrates them before serving, and returns the restorable bundle with its metadata and resolved runtime state from source-authenticated `GET /v1/deployment-layer`. Removed layer-owned skills are archived. Filesystem `DEPLOYMENT_LAYER` remains a bootstrap input for local and recovery use.

The sandbox handoff is a substrate image pin plus a layer content hash. Docker and Fly use `sandbox publish` to push an OCI image, resolve its immutable digest, and record it in the config. AWS with `sandbox.backend: "aws"` (or no sandbox block) uses `infra build-image` to package the guest agent as a Lambda MicroVM image and records its immutable image version and execution role; with `sandbox.backend: "sprites"`, `sandbox publish` pushes the layer image and records its digest pin in the durable deployment manifest, which `up`, `check --live`, and `rollback` resolve. Service task definitions and sandbox root filesystems use immutable pins, not mutable tags.

Postgres stores create their tables lazily with idempotent DDL through the shared pool. The Terraform module creates RDS and its `DATABASE_URL` secret. On AWS, `up` takes a manual RDS snapshot before its first mutation — refusing an unavailable database or one whose automated-backup retention is below `aws.dbRetentionMinDays` (default 1) — named after the deployment manifest it precedes and recorded in that manifest; older pre-deploy snapshots are pruned to a bounded count, and `aws.predeployDbSnapshot: false` opts a deployment out. Restore remains operator-run: `rollback` prints the snapshot to restore alongside the code it rolls back.

## Targets and prerequisites

| Requirement                                                                                |                          Docker |                             Fly |                                             AWS |
| ------------------------------------------------------------------------------------------ | ------------------------------: | ------------------------------: | ----------------------------------------------: |
| Node 24 and `qm` CLI                                                                       |                             yes |                             yes |                                             yes |
| Docker daemon                                                                              |                             yes |                      build path |                       image transfer/build path |
| Agent-computer image and credentials                                                       |      Fly app for real execution |        Fly app and scoped token | Lambda MicroVM image/version and execution role |
| Slack bot app created from generated manifest, bot token, app token                        |              when Slack enabled |              when Slack enabled |                              when Slack enabled |
| Admin email, verified sender, and a Resend key or SMTP credentials                         | with the built-in `auth` broker | with the built-in `auth` broker |                 with the built-in `auth` broker |
| Slack SSO app, client id/secret, team gate, and exact `<publicUrl>/auth/callback` redirect |            only with Slack OIDC |            only with Slack OIDC |                            only with Slack OIDC |
| Postgres                                                                                   | local container or supplied DSN |       Fly Postgres/supplied DSN |                                   Terraform RDS |
| AWS credentials, ECS/ECR/RDS/ALB/Cloud Map, exact GitHub OIDC trust                        |                              no |                              no |                                             yes |

`doctor` checks target resources read-only. When user-owned CI is requested, the AWS account must already have the account-level GitHub provider at `arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com`; check it with `aws iam get-open-id-connect-provider --open-id-connect-provider-arn <arn>` and, if absent, have an account administrator run `aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com`. The AWS doctor verifies ECS, ECR, RDS, CloudFront-to-ALB routing, the deploy role and its exact operator-owned GitHub repository plus configured branch or environment trust, required secret values, and the Lambda MicroVM image pin. Environment-based trust must be paired with GitHub deployment-branch restrictions because its OIDC subject does not contain a branch. Fork pull requests cannot assume the deploy role. No workflow in the qm source repository deploys a production stack.

## Commands, conformance, and versioning

The normal gate order is `check`, `doctor`, substrate image build, `plan`, `up --yes`, then `check --live`. The substrate step is `sandbox publish` on Docker/Fly and `infra build-image` on AWS. First-party services come from the package's matching image manifest; `--build-from` is an explicit contributor escape hatch for unreleased source. `check` is static and has JSON output keyed to clause ids. `doctor` makes read-only external checks. `plan` renders without mutation. On AWS, rollback restores the prior recorded deployment manifest as one unit under the deployment lease; `--to` selects another complete manifest by manifest id or recorded release label. Because rollback restores code and configuration but never data, it prints the pre-deploy database snapshot recorded on the deployment it rolls back. On Fly it restores a sandbox pin. Docker does not claim rollback.

AWS `up` is mutually excluded by a DynamoDB lease, snapshots the RDS instance before its first mutation, registers digest-pinned task definitions, enables the ECS circuit breaker, updates services, and waits stable. AWS `check --live` compares environment, secret routing, task definitions, sandbox pins, and the configured release label in both directions. Fly `check --live` verifies every configured workload has a live image-bearing machine and the public health endpoint responds. `qm conformance` remains the later cross-check between the static contract and core's resolved deployment-layer descriptors.

The semver-stable `@yc-software/qm/contract` export contains only config loading, layer validation/parsing, env derivation, approval compilation, and the contract version; AWS task rendering joins it with the AWS backend. A new incompatible directory shape increments the contract major. A CLI may add optional fields within a major.

Built-in targets live in one registry that owns discovery, initialization files and ignores, accepted deploy flags, backend creation, sandbox publication, and provider output coordinates. To add one, implement that provider contract and backend lifecycle (`up`, status, logs, down, rollback, doctor, secret delivery, live checking, and sandbox pinning), add a namespaced config block and templates, render through the shared environment and secret pipelines, document prerequisites honestly, and add conformance fixtures. Loading arbitrary provider packages at runtime is outside contract v1.

## Clause status

| Clause                            | Status         | Verifier                                                                         |
| --------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| `config.v1`                       | ENFORCED       | `loadConfigAt`, `qm check`                                                       |
| `config.no-secret-values`         | ENFORCED       | `qm check`                                                                       |
| `secrets.computed-set`            | ENFORCED       | typed schema, `qm check`                                                         |
| `sandbox.descriptors`             | ENFORCED       | `validateSandboxLayer`, core PUT validation                                      |
| `sandbox.approvals-tighten`       | ENFORCED       | descriptor parsers, command-policy composition                                   |
| `runtime.layer-resolved`          | ENFORCED       | deployment-layer store/API and core PUT validation, `qm conformance` cross-check |
| `aws.rendered-task`               | ENFORCED       | `renderTaskDefinition`, AWS `plan`/`up`, digest and task-diff tests              |
| `aws.live-drift`                  | ENFORCED       | `qm check --live`, bidirectional task/environment/secret/release checks          |
| `sandbox.egress`                  | VALIDATED-ONLY | wildcard/host warnings in `qm check`; no runtime enforcement claimed             |
| `sandbox.aws-substrate`           | ENFORCED       | Lambda MicroVM image/version validation and live drift                           |
| `target.provider-registry`        | ENFORCED       | provider registry and packed-artifact tests                                      |
| `extension.deployment-data-proxy` | RESERVED       | optional env-gated org adapter; not part of contract v1                          |

ENFORCED means code rejects or tests the clause today. VALIDATED-ONLY means the directory is checked but runtime enforcement is explicitly absent. RESERVED names a compatibility slot without claiming implementation.
