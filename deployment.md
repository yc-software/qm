# Deploy QM

The deployment workflow shipped by this repository is
[`cli/templates/deployment/deployment.md`](cli/templates/deployment/deployment.md).
Read it completely and follow it as the authoritative workflow.

The same file is materialized into every organization's deployment directory by
`qm init`, together with its agent skill and provider references. Use a standalone deployment
repository for package deployments. To change QM source, follow the source-fork and
explicit build instructions in [the README](README.md#customize-your-instance); see
[`deploy/layers/README.md`](deploy/layers/README.md) for deployment layout.
