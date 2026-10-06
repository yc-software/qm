---
name: deploy-qm
description: Deploy the QM package from an organization-owned repository to local Docker, Fly.io, AWS, or Porter, onboard an administrator, configure connectors, and optionally activate Slack.
---

# Deploy QM

Offer local Docker alongside Fly.io, AWS, and Porter. For Docker, read
`references/docker.md` before configuring services and secrets; no cloud account
is required. Use its local acceptance checks, not the unsupported `check --live`.

Read [`../../../deployment.md`](../../../deployment.md) completely and follow it
as the authoritative workflow. Read only the selected provider reference. Read
`references/email.md` before collecting email secrets. Administrators can defer
email setup and use `qm admin-login`; ordinary email sign-in needs a transport. Read
`references/slack.md` only when Slack is requested.

A deployment needs a base model key and a way for people to sign in. Collect
both in the same pass. Offer email and password for getting started, email
links, or an external OIDC provider such as Slack; read `references/sign-in.md`
before choosing. For models, offer direct Anthropic, OpenAI, or OpenRouter
keys (`modelProvider`), or an existing LiteLLM-style router endpoint. Read
`references/model-gateway.md` for the router path; it does not require a direct
provider key or a new provider account.

Use the installed `@yc-software/qm` dependency through `npm exec qm -- <command>`. Do
not require or clone the QM source repository. Complete every acceptance check
and return the handoff required by `deployment.md`. For Fly and AWS, treat `qm check --live` and
its private live session canary as the automated release gate; still complete
the administrator's manual sign-in and web acceptance check.
