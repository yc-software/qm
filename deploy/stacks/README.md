# Deployment fixtures

The directories here are account-neutral contract fixtures for the `qm` CLI.
They are not production deployments and CI does not deploy them.

To self-host qm, start from the repository-root
[`deployment.md`](../../deployment.md). It creates the organization's deployment directory
under [`../layers/`](../layers/), asks for the operator's AWS account before mutation,
and generates the optional bot manifest. It generates a separate Slack SSO manifest only
when Slack is selected as the OIDC provider. Secrets belong in the provider's encrypted
secret store and never in these fixtures.
