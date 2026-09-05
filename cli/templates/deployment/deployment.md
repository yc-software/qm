# Deploy QM

This repository defines one QM deployment. The `@yc-software/qm` dependency supplies
the deployment engine; this repository owns the organization-specific config,
sandbox layer, provider coordinates, and generated Slack manifests.

The automated release gate is `qm check --live`, including its private live
session canary. The task is complete only after that gate passes, the
administrator can sign in and receive a real web response, and, when Slack is
requested, the bot replies in a test channel.

## 1. Collect choices and authorization

Before cloud mutation, read `qm.config.jsonc` when it exists. Its `target` is
the selected provider; confirm it with the operator and do not offer to change
it in place. If the repository has not been initialized, collect:

- hosting target: a cloud provider — Fly.io, AWS, or Porter. Recommend Fly.io
  when the operator has no preference. Porter deploys onto a Kubernetes
  cluster in the operator's own cloud account and has no `qm` CLI target:
  choosing it switches this workflow to `references/porter.md`, which drives
  the Porter CLI and dashboard directly. The docker target runs everything on
  the local machine, is for a quick local test drive only, and is outside this
  workflow; never present it as the recommended path for a real deployment;
- the first administrator's verified work email;
- how people sign in: the built-in `auth` broker, which emails a one-time link,
  or an external OIDC provider. Ask whether the company runs on Slack before
  assuming the broker — Slack sign-in needs no email transport, no sending
  domain, and no DNS, and domain verification is the step most likely to stall
  a deploy. Recommend Slack sign-in to a Slack workspace and the broker
  otherwise;
- model provider: Anthropic, OpenAI, or OpenRouter (one key that routes to
  many models). This is a deployment choice, not a post-deploy one: it becomes
  `modelProvider` in `qm.config.jsonc`, which makes that provider's API key a
  required secret. Collect the key in the same pass as the other credentials —
  a deployment that cannot answer one message is not finished. An operator who
  genuinely wants to defer omits `modelProvider` and adds the key from the
  Admin page later, but do not offer that as the default;
- model;
- region and provider account or organization;
- whether the provider hostname is acceptable;
- connectors to enable, including whether to add Slack now.

The deployment slug is a local name for this deployment — it appears in the
package name, resource names, and Slack branding. Derive it from the
organization's name (a lowercase DNS label) and confirm it in passing; do not
make the operator decide it as a standalone question. On Fly.io the slug is
the default `appPrefix`, and app names like `<prefix>-core` must be free on
fly.dev; on a collision set a distinctive `appPrefix` rather than renaming
the organization.

Explain the selected provider's billable resources and confirm the provider
identity, region, resource list, and expected billing.

Changing providers means initializing a new empty deployment directory. Never
rewrite only `target`; provider config, files, secret rules, and teardown
contracts are scaffolded as one unit.

## 2. Prepare the deployment repository

Require Node 24+, npm, Git, Docker with Buildx, and `openssl`.

For a repository without `qm.config.jsonc`, first confirm the hosting target
and the derived slug, then initialize its root with the current CLI:

```bash
npm exec --yes --package=@yc-software/qm@latest -- \
  qm init . --org <slug> --target <fly-or-aws> --model-provider <provider>
npm install
```

`qm init` writes the version it resolved to as an exact dependency, so the pin
lands in the deployment repository and its lockfile rather than in the command
that bootstraps it.

`--model-provider` takes `anthropic`, `openai`, or `openrouter` and defaults to
`anthropic`. It writes `modelProvider` into the scaffolded config, which is what
promotes that provider's key from an optional fallback to a required secret.

For an already-initialized clone, install reproducibly. Use `npm ci` when
`package-lock.json` exists; otherwise use `npm install` to create it:

```bash
test -f package-lock.json && npm ci || npm install
npm exec qm -- version
```

Confirm `.env` is private and ignored before adding credentials:

```bash
test "$(stat -f '%Lp' .env 2>/dev/null || stat -c '%a' .env)" = 600
git check-ignore --quiet .env
```

Never print, paste into chat, or commit `.env`. Never initialize over an
existing deployment config.

## 3. Configure the administrator, sign-in, and the base model

Set the exact lowercased administrator email in `.env` as
`ADMIN_GRANTS=<email>:org_admin`.

Follow the sign-in route chosen in step 1. Only the `auth` broker needs an email
transport; skip to "Slack sign-in" below when the operator picked Slack, and
skip `references/email.md` entirely with it.

### The built-in broker

The `auth` broker emails a one-time link. There is no identity provider to
register: the CLI generates the broker's signing key and the portal's client
credentials and derives every `OIDC_*` value from `publicUrl`. Setting any of
them by hand is refused.

Email setup can be deferred: after deployment, `qm admin-login` prints a
single-use link for the configured administrator, valid for five minutes.
It needs the deployment's local signing secret and creates no account or role
grant. Keep the link private. `qm setup` asks whether to configure email now;
skip that step for an initial administrator-only deployment.

For ordinary user sign-in, the operator supplies a way to send emails. Do not ask them to
pick a transport by name; ask what they already use for email. An existing
mail account or relay (Google Workspace, Postmark, SES, Fastmail) means SMTP —
recommend it, since it needs no DNS work — and only an operator who prefers
Resend and controls DNS for a sending domain should pick `resend`. Set
`env.auth.AUTH_EMAIL_TRANSPORT` accordingly, optionally set
`env.auth.AUTH_ALLOWED_EMAIL_DOMAIN` to admit a whole domain, then read
`.codex/skills/deploy-qm/references/email.md` before collecting secrets — the
Resend path needs DNS control you will not have, so raise it with the operator
early. Configure services, model, and the final public origin in the same pass.

### Slack sign-in

A workspace that already runs on Slack can sign in with it and skip email
altogether. Drop `"auth"` from `services` and follow
`.codex/skills/deploy-qm/references/slack.md`, which covers the SSO app, the
`env.portal` endpoints, the workspace trust boundary, and the client
credentials. The bot app in that same reference is a separate decision — Slack
sign-in does not require the agent in the workspace, and the agent does not
require Slack sign-in.

### Another OIDC provider

To use a different work-email OIDC provider, drop `"auth"` from
`services`, register `<publicUrl>/auth/callback` with the provider, and put its
endpoints and the email gate in `env.portal`. For Google Workspace:

```json
{
  "OIDC_AUTH_ENDPOINT": "https://accounts.google.com/o/oauth2/v2/auth",
  "OIDC_TOKEN_ENDPOINT": "https://oauth2.googleapis.com/token",
  "OIDC_USERINFO_ENDPOINT": "https://openidconnect.googleapis.com/v1/userinfo",
  "OIDC_ISSUER": "https://accounts.google.com",
  "OIDC_JWKS_URI": "https://www.googleapis.com/oauth2/v3/certs",
  "OIDC_SCOPES": "openid email profile",
  "OIDC_PRINCIPAL_CLAIM": "email",
  "OIDC_ALLOWED_EMAILS": "<verified-work-email>"
}
```

### Playground mode

A playground is a public try-it deployment: unauthenticated visitors get
anonymous browser-pinned identities instead of a sign-in page, while the one
administrator still signs in through whichever route above the deployment
configured. Enable it in `qm.config.jsonc`:

```json
"env": { "portal": { "PORTAL_PLAYGROUND": "1" } }
```

A playground must be its **own deployment**, never a flag on a working org's
instance: every visitor is an ordinary internal principal of the deployment's
org, so anything granted or published at org scope — including org-granted
credentials — is theirs. Grant nothing sensitive at org scope, connect no real
connector credentials, and load no company data. A cleared cookie is a fresh
identity, so set `env.core.ORG_BUDGET_USD_PER_WINDOW` — the one hard spend
ceiling — in the same pass, and from the Admin page after first boot restrict
the model picker to the subset you want to offer (one model or several).
Nothing garbage-collects an abandoned visitor's scope yet.
`plugins/portal/README.md` § "Playground mode" covers the rest: per-address
mint limits, the boot refusals, and what anonymous visitors are denied.

### The base model

Whichever sign-in route the deployment takes, the base model needs a key in the
same pass. `modelProvider` decides which one `qm setup` asks for —
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY` — and the wizard
prints where to mint it. The operator owns the billing relationship, so they
create the key; you only place it. It is a required secret, so `qm doctor` calls
the provider to prove the key is accepted and `qm up` refuses a deployment that
has none. Treat a rejected key exactly like a rejected sign-in credential: stop
and get a working one rather than deploying a stack that greets the
administrator and then fails their first message.

`modelProvider` also picks the model itself, so no model id has to be chosen at
deploy time: Anthropic serves `claude-opus-5`, OpenAI `gpt-5.6-sol`, OpenRouter
`openrouter/auto`. Set `model` in `qm.config.jsonc` only to override that, and
only with a model the chosen provider can bill — a mismatch is refused at
startup rather than at the first message. The same rule covers the harness:
`HARNESS` `codex` runs OpenAI models alone, `claude` runs Anthropic models
alone, and `openrouter` needs the default `pi` harness.

An operator may still prefer to hold the key centrally and rotate it from the
Admin page. That is a deliberate choice, not the default: drop `modelProvider`
from `qm.config.jsonc`, note in the handoff that the deployment has no base model
yet, and finish by walking them through Model provider on the Admin page. Never
leave a deployment modelless without saying so.

Read exactly one provider reference now and follow its provider-specific
preflight and setup order:

- Fly.io: `.codex/skills/deploy-qm/references/fly.md`
- AWS: `.codex/skills/deploy-qm/references/aws.md`

## 4. Deploy and prove the web surface

Follow the selected provider reference, then run:

```bash
npm exec qm -- check --live
npm exec qm -- conformance
npm exec qm -- outputs --json
```

`check --live` verifies provider infrastructure, private storage, public
health, and a private end-to-end web session. The session canary runs one real
agent turn plus auxiliary title generation, verifies the exact reply and
persisted transcript, requires a generated title, checks the session-scoped
error log, and archives itself. It does not recall or capture administrator
memory. Fly runs it inside the core machine; AWS runs it as a one-off task on
the core service's private network. It does not add a public session endpoint.

Open `adminOnboardingUrl` from the JSON output and confirm Model provider
reports the chosen vendor as configured, sourced from the environment. It does
when `modelProvider` is set: the key travelled with the rest of the deployment
secrets, so there is nothing to paste here. Enter and validate a key on that
page only when the operator chose to defer, or when they are replacing the
deployment key with one they would rather rotate from Admin — the write-only
surface stores it in durable encrypted storage and takes precedence over the
deployment key. On the deferred route, set Base model on that same page after
the key: a key alone leaves the deployment on a model it cannot bill.

Never paste any provider key into chat or terminal output. `.env` is the one
place a deployment key belongs, and `qm secrets push` moves it without printing
it.

Open `webUiUrl`, sign in as the seeded administrator, send a message, and
receive a real model response. Use a specific request rather than a greeting,
then confirm its generated sidebar title replaces the `Web chat` fallback. A
missing title is one failed runtime assertion; inspect the core error log and
rerun `check --live` before continuing. Ask the agent to create a fresh UUID in
`/root/workspace/qm-computer-proof.txt`, then use the provider reference's
independent proof to verify that UUID outside the model transcript.

## 5. Configure connectors

Open `adminConnectorsUrl` from `outputs --json`. For each chosen connector:

1. Open the provider-console link shown by Admin.
2. Register the exact callback shown there.
3. Enter the client id and secret in the write-only fields and save.
4. Open `userConnectionsUrl` and complete one real user connection.

Verify configured connectors appear and unconfigured connectors remain hidden.

## 6. Add the Slack bot

This is the agent in the workspace, not sign-in; a deployment using Slack
sign-in already created its SSO app in step 3. Skip this when the bot was
deferred. Otherwise read `.codex/skills/deploy-qm/references/slack.md`, then run:

```bash
npm exec qm -- slack render
npm exec qm -- outputs
```

Create the app from the exact bot manifest URL. Enter its bot and app tokens in
the Admin Slack card, invite it to a test channel, mention it, and receive a
reply.

## 7. Return the handoff

Return:

- the web, Admin onboarding, Admin connectors, and user connections URLs;
- how people sign in, and the Slack SSO app link when that is the route;
- Slack bot app and test-channel links when enabled;
- provider, account or organization, and region;
- the base model provider and where its key lives — the deployment `.env` or the
  Admin page — so the operator knows what to rotate and where;
- pass/fail for health, the private live session canary, sign-in, manual web
  chat and generated title, agent-computer proof, connector visibility, user
  OAuth, Slack reply, conformance, and an idempotent deployment rerun;
- `npm exec qm -- status`, logs, rollback, and teardown commands;
- recurring cost or manual work still owned by the operator, including model
  usage billed directly by the provider.

Do not claim completion with a missing test or placeholder. If blocked, leave
the repository resumable and name the exact next human action without exposing
a secret.
