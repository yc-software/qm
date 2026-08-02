# Documentation

This page is the entry point for QM and Agent Squad Workspace documentation. Each
document should identify whether it describes current behavior, a proposal, or a
reusable template. Code and tests remain the final evidence for implemented behavior.

## Product users

- [QM overview](../README.md) describes the current product and its supported surfaces.
- [Deploy QM for an organization](./getting-started.md) gives the current deployment
  starting point.
- [Security policy](../SECURITY.md) states the current trust boundaries, operator
  assumptions, and known limitations.
- [Agent Squad Workspace](./agent-squad-workspace/README.md) describes a planned QM
  extension. It is not a list of currently available capabilities.

## Contributors

- [Repository working rules](../AGENTS.md) define the required development and review
  practices.
- [Contributing](../CONTRIBUTING.md) explains how to propose a change.
- [CLI end-to-end tests](../cli/test/e2e/README.md) describe the deployment CLI test
  harness.
- [Documentation policy](./documentation-policy.md) defines document ownership,
  status, naming, links, and update triggers.

The root `package.json` is the source for local commands. The normal documentation-only
check is:

```bash
npm run format:check
```

The repository pins Node and npm versions in `.node-version` and `package.json`.

## Platform operators

- [Deployment workflow](../deployment.md) points to the authoritative generated
  runbook.
- [Deployment directory contract](./deploy-directory.md) is the normative deployment
  schema and lifecycle contract.
- [QM CLI](../cli/README.md) lists current commands and package behavior.
- [Deployment templates](../deploy/README.md) explains the shipped service topology and
  fixtures.
- [Organization layers](../deploy/layers/README.md) defines the private-fork boundary.
- [Slack surface](../src/slack/README.md) covers Slack setup and behavior.

Plugin-specific setup and contracts live beside each plugin:

- [Admin](../plugins/admin/README.md)
- [Authentication broker](../plugins/auth/README.md)
- [Onboarding](../plugins/onboarding/README.md)
- [Portal](../plugins/portal/README.md)
- [Web UI](../plugins/web-ui/README.md)

## Maintainers

- [Documentation audit](./documentation-audit-2026-08-02.md) records the current
  inventory, gaps, and prioritized follow-up work.
- [ADR template](./templates/adr.md)
- [Feature specification template](./templates/feature-spec.md)
- [API and message protocol template](./templates/api-message-protocol.md)
- [Runbook template](./templates/runbook.md)
- [Test plan template](./templates/test-plan.md)
- [Acceptance record template](./templates/acceptance-record.md)
