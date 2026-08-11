---
name: deploy-qm
description: Deploy the QM package from an organization-owned repository into Fly.io or AWS, onboard an administrator, configure connectors, and optionally activate Slack.
---

# Deploy QM

Read [`../../../deployment.md`](../../../deployment.md) completely and follow it
as the authoritative workflow. Read only the selected provider reference. Read
`references/email.md` before collecting secrets, because sign-in needs an email
transport and one of its steps needs the operator's DNS. Read
`references/slack.md` only when Slack is requested.

A deployment needs a base model key and a way for people to sign in. Collect
both in the same pass. The base model provider is a deployment choice recorded
as `modelProvider`, not a setting to leave for the Admin page. Sign-in is either
the built-in `auth` broker, which needs an email transport, or an external OIDC
provider such as Slack, which needs no email at all — read `references/email.md`
only once the operator has chosen the broker.

Use the installed `@yc-software/qm` dependency through `npm exec qm -- <command>`. Do
not require or clone the QM source repository. Complete every acceptance check
and return the handoff required by `deployment.md`. Treat `qm check --live` and
its private live session canary as the automated release gate; still complete
the administrator's manual sign-in and web acceptance check.
