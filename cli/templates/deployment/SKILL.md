---
name: deploy-qm
description: Deploy the QM package from an organization-owned deployment repository to Fly.io or AWS, onboard an administrator, configure connectors, and optionally activate Slack.
---

# Deploy QM

Read `../../../deployment.md` completely and follow it as the authoritative
workflow. Read only the selected provider reference. Read `references/email.md`
before collecting secrets, because sign-in needs an email transport and one of
its steps needs the operator's DNS. Read `references/slack.md` only when Slack
is requested.

A deployment needs two credentials from the operator before it can do anything
useful: a way to send sign-in mail, and a base model key. Collect both in the
same pass. The base model provider is a deployment choice recorded as
`modelProvider`, not a setting to leave for the Admin page.

Use the repository's installed `@yc-software/qm` dependency through
`npm exec qm -- <command>`. Do not require or clone the QM source repository.
Do not stop at infrastructure health: complete the acceptance checks and return
the handoff required by `deployment.md`.
