# Organization layers

A private source fork can keep its deployment material under `deploy/layers/<org>/`.
Core code may change independently to implement the organization's desired behavior.
Public source checkouts keep private deployment material in a separate private
repository. Package deployments need only that deployment repository, with no source
fork. See [the README](../../README.md#customize-your-instance) for both paths.

Upstream qm keeps only this shared README here. Organization layers never travel
upstream; `upstream-pr` checks that boundary when a contribution is requested.

## Creating a layer

```bash
node cli/bin/qm.ts init deploy/layers/<org> --org <slug> --target <fly-or-aws>
```

`qm init` writes the deployment config, the secret-name example, the sandbox and provider
scaffolding, an operator runbook, and a per-directory `.gitignore` that keeps `.env` values
and Terraform state out of Git. Generate the layer rather than hand-building it so that
`.gitignore` comes with it; the root `.gitignore` covers the same files as a backstop.

The result, described in full in [`docs/deploy-directory.md`](../../docs/deploy-directory.md):

```text
deploy/layers/<org>/
  qm.config.jsonc          the deployment config; committed, no secret values
  .gitignore               scaffolded; keeps .env and tfstate out of Git
  .env.example             computed secret names, never values
  .env                     local secret values; never committed
  sandbox/                 org tools and skills for agent computers
  plugins/<name>/          org-specific service images
  infra/                   provider infrastructure and tfvars, on AWS targets
  slack-app-manifest.yml   generated bot manifest
  deployment.md            operator runbook
```

Point the CLI at a layer with `--config`:

```bash
node cli/bin/qm.ts check --config deploy/layers/<org>/qm.config.jsonc
```

For a separate deployment directory, substitute its path in both commands.
Deploy modified services with the explicit `--build-from` workflow in the README.
Run the CLI from the tree as shown. `npm exec qm` does not work in a source checkout
because the workspace symlink points at `cli/`, which is unbuilt.

## Nearby directories

`deploy/stacks/` holds account-neutral contract fixtures used to test the Fly backend, and
`deploy/<service>/` holds the service image and Fly templates the CLI renders from. Neither
is a place for organization material.

## The rule

Nothing under `deploy/layers/` may reach upstream qm: not the config, not the sandbox
tools, not the infrastructure coordinates, and not the names of systems or people that
appear inside them. Secrets never enter Git at all, in this directory or any other. They
belong in the provider's encrypted secret store, with local values only in the gitignored
`.env`.
