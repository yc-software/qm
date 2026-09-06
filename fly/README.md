# Sandbox base image

`fly/Dockerfile` builds the shared sandbox **base image**: a minimal generic toolset
(the coding-agent CLIs, AWS CLI v2, the baked Python venv at `/opt/agent-venv`, and the
optional agentic browser engine behind the `INSTALL_BROWSER_ENGINE` build arg). The
directory name is historical — it predates the retirement of the Fly Machines sandbox
backend — and stays because the Dockerfile is consumed by paths that pin it by name.

Where the image is used:

- **Signed releases.** `release-package.yml` builds and signs it as
  `ghcr.io/<org>/qm-sandbox-base` alongside the service images.
- **Local docker sandboxes.** `scripts/local-sandbox-build.sh` builds it as
  `qm-sandbox-base:dev`, then stacks `local/Dockerfile` on top to produce
  `qm-sandbox-local:latest` for `SANDBOX_BACKEND=local`.
- **Deployment layer builds.** A deployment's `sandbox/Dockerfile` may build FROM a
  published base via `qm sandbox build` (a local validation build).

Runtime sandbox backends (sprites, smolmachines, e2b, modal) do **not** boot this
image: they boot their platform's stock image, and the deployment layer's tool
descriptors and skills arrive through the deployment-layer sync.

Deployment-specific tools are NOT baked here — a deployment stacks them via its
sandbox layer (`qm sandbox build` over `<deploy dir>/sandbox/`). `fly/tools/x-api` is
copied into the image by the Dockerfile and its file list feeds the local sandbox
image fingerprint (`src/sandbox/local-sandbox.ts`).
