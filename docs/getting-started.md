# Deploy QM for an organization

Deploying QM does not require a copy of this repository: `qm init` materializes a
deployment directory from the published package. Start in an empty organization-owned
private repository:

```bash
npm exec --yes --package=@yc-software/qm@latest -- \
  qm init . --org <slug> --target <fly-or-aws>
npm install
```

Choose Fly.io or AWS before initialization; the slug is a local name derived from the
organization, not globally unique. Customize config, tools, skills, and services in this
directory. To change QM itself, use a public or private source fork and explicitly
build its source, as described in [the README](../README.md#customize-your-instance).
A private source fork can keep its deployment at `deploy/layers/<org>/`; a public source
checkout uses a separate private deployment directory. See
[`../deploy/layers/README.md`](../deploy/layers/README.md).

Provider choice is part of initialization because it determines the config,
secret rules, generated files, and teardown contract. Changing providers means
initializing a new empty directory. `qm init` materializes `deployment.md` and
`.codex/skills/deploy-qm/`. Hand that skill to an agent. It confirms the
operator-owned account and billing before mutation, configures email-gated web
onboarding first, optionally adds connectors and Slack, performs live checks,
and returns the operational URLs. Sign-in defaults to the built-in `auth`
broker, which emails a one-time link: supply the admin address, a verified
sender, and a Resend key or SMTP credentials, and the CLI generates and wires
everything else. Drop `"auth"` from `services` to use an external identity
provider instead; that provider must then register the exact
`<publicUrl>/auth/callback` redirect.

The installed package carries Fly and AWS provider templates and dispatches
their common lifecycle through the hosting-provider registry. Initialization
does not create deployment CI, and the QM source repository has no production
deployment workflow.
