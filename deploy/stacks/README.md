# Fly deployment fixtures

The directories here are account-neutral contract fixtures for the `qm`
Fly backend. They are not production deployments and CI does not deploy them.

To self-host qm, start from the repository-root
[`deployment.md`](../../deployment.md). It creates the organization's deployment directory
under [`../layers/`](../layers/), asks for the operator's Fly organization or AWS
account before mutation, and generates the optional bot manifest. It generates a
separate Slack SSO manifest only when Slack is selected as the OIDC provider.

The checked-in `deploy/<service>/fly.toml` files remain the service templates.
The CLI derives per-deployment copies under the ignored
`deploy/stacks/.generated/` directory. Secrets belong in the provider's encrypted
secret store and never in these fixtures.
