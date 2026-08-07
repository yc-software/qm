# Things that blocked a first AWS deployment (August 2026)

Notes from standing up a fresh `--target aws` deployment (ap-northeast-1, Slack OIDC,
in-house model endpoint). Each item stopped the deployment until it was worked around.
Listed roughly by how much damage it does.

## 1. `ADMIN_GRANTS` is a first-boot seed, and nothing says so

`bootAdminGrantSeed` is only applied when the grant table is empty
(`src/admin/admin-grant-store.ts`). Once the stack has booted, editing `ADMIN_GRANTS`
and redeploying silently does nothing.

Seeding an address that cannot sign in locks the deployment out of its own Admin area:
the seeded admin can never authenticate, and the person who can authenticate cannot be
granted anything, because granting requires an existing admin. We hit exactly this by
seeding a shared mailbox that had no Slack account under Slack OIDC.

Recovery required running a one-off ECS task on the core task definition to insert a row
into `admin_grants` directly, because RDS is VPC-private and ECS Exec is off. That is not
a procedure an operator can be expected to invent.

Worth having: `qm check` or `qm doctor` warning when `ADMIN_GRANTS` differs from the live
durable grants, a documented recovery path, and a note in `.env.example` that the value is
a seed rather than a setting.

## 2. Pinned `gh` version in the MicroVM agent image has rotted

`cli/templates/aws/microvm-agent/Dockerfile` pins `gh-2.96.0-1`. The GitHub CLI RPM
repository does not keep old versions, so the pin no longer resolves and every
`qm infra build-image` fails.

This is worse than it sounds because AWS returns no diagnostic: the image version goes to
`CREATE_FAILED` with no `stateReason`, and the CloudWatch log group is created but never
gets a log stream. Nothing in the AWS console or API says why. We only found it by
reproducing the Dockerfile build locally under arm64 emulation.

Since the MicroVM image version is immutable once built, an unpinned `gh` seems fine here
and would stop this from recurring.

## 3. Published images are amd64 only, but the scaffold defaults to arm64

`aws.services.<name>.architecture` defaults to `arm64`. The images the released package
points at (`ghcr.io/yc-software/qm/*`) are single-arch amd64. A stock
`qm init --target aws` followed by a deploy therefore puts amd64 images into arm64 task
definitions.

Either the published images should be multi-arch, or the scaffold should default to
amd64 to match what it will actually pull.

## 4. `npm audit` gate in the core image blocks building from source

`deploy/core/Dockerfile` runs `npm audit --omit=dev --audit-level=moderate` as part of the
build. Production dependencies currently carry `undici` advisories reached through
`@earendil-works/pi-coding-agent` with no fix available, so the gate cannot pass and
`--build-from` is impossible.

CI is a better home for this gate than the image build; failing the image build means an
advisory with no upstream fix stops deployments entirely.

## 5. Running the CLI from a source checkout hits sentinel image references

`cli/manifest.json` in the repository holds `registry.invalid/...` placeholders. That is
intentional, but nothing warns you: running `node cli/bin/qm.ts up` from a checkout fails
deep into the deploy with a DNS error for `registry.invalid`, well after infrastructure
has been created and secrets pushed.

A check that the manifest is a sentinel, pointing at either the released package or
`--build-from`, would save the confusion.

## 6. Quoted values in `.env` silently become part of the secret

`.env` is parsed as plain `KEY=VALUE`. Writing `OIDC_CLIENT_ID="123.456"` stores the
quotes, and they travel all the way to the provider — Slack received a `client_id` with
literal `%22` on each end. Nothing rejects it; sign-in just fails at the identity
provider with an unhelpful message.

`qm check` already validates secret shapes for some names; rejecting surrounding quotes
would be cheap.

## 7. The agent misdiagnoses missing credentials in shared scopes

A Slack channel conversation asked the agent to use Google Workspace. The connector was
configured at org scope and the asking user had connected their own Google account, but
the credential is owned by their personal scope and no keychain grant existed for the
channel. Refusing is correct.

The explanation was not: the agent said Google needed to be "enabled in the channel's
administrator settings", which does not exist. It sends the user to a setting they cannot
find instead of to the grant flow that would actually unblock them.

## Smaller notes

- `qm infra delete-image --yes` deleted the image and then threw during artifact cleanup;
  a second run reported success.
- `qm up` reports "no task-definition change" when only a Secrets Manager value changed,
  so running tasks keep the old value. Reaching for
  `ecs update-service --force-new-deployment` is not obvious, and the CLI could either do
  it or say that it is needed.
- Putting a proxying CDN (Cloudflare) in front of the ALB fails the `public URL DNS and
  TLS` check, because the public hostname resolves to the CDN rather than the ALB. Setting
  `AWS_PUBLIC_ORIGIN_URL` to the ALB works around it, but the check assumes CloudFront.
