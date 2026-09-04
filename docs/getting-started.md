# Deploy QM for an organization

Deploying QM does not require a copy of this repository: `qm init` materializes a
deployment directory from the published package, and the README section "Deploy it for
your org" gives that path. An organization that wants to customize its deployment keeps
a private fork of the QM repository and puts everything specific to itself in one
directory, `deploy/layers/<org>/`: its config, sandbox customizations, provider
coordinates, and generated Slack manifests. The rest of the tree stays identical to
upstream. See [`../deploy/layers/README.md`](../deploy/layers/README.md).

For a new layer, the agent first asks the operator for Fly.io or AWS (the slug
is a local name derived from the organization, not globally unique), then runs:

```bash
node cli/bin/qm.ts init deploy/layers/<org> --org <slug> --target <fly-or-aws>
```

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
