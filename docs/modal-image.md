# Prebuilt Modal image

Build the sandbox image before deploying core to keep package installation and image
building out of the first user turn. No credentials are used during this build.

From the matching source checkout, install dependencies with `npm ci`, configure Modal
authentication, then run:

```bash
MODAL_APP_NAME=qm npm run build:modal-image
```

The command eagerly builds the image on Modal and prints `MODAL_IMAGE=im-...`. Save that exact image ID in the
core deployment's `MODAL_IMAGE` setting. Use the same Modal workspace and environment
for building and running; `MODAL_ENVIRONMENT` selects the SDK environment. The build
does not change running sandboxes or deploy core.

With no `MODAL_IMAGE` set during the build, the image starts from QM's pinned Node
base and installs its usual shell, Python, Git, curl, and archive utilities. It also
installs a pinned, checksum-verified `uv`, configures `uv pip install` to target the
system Python without a virtual environment, and preinstalls pinned requests,
beautifulsoup4, lxml, openpyxl, pypdf and python-docx, plus a pinned, checksum-verified
AWS CLI v2 so agents don't fall back to `pip install awscli` (v1, which lacks SSO
device-code login). Packages installed later with
`uv pip install` land in `/usr/local`, outside home checkpoints, so they last until the
sandbox is replaced. To extend an existing custom image, set `MODAL_IMAGE` to its
registry reference (prefer an immutable digest) or an existing Modal image ID. Custom bases must already contain
Node, npm, and QM's baseline utilities; this preserves the existing custom-image
contract. Building again from the same inputs uses Modal's layer cache.

Native home checkpoints are directory snapshots of `/root`, so everything installed
under the home is captured again in every checkpoint. Deployment-layer tool files are
converged under `/usr/local/bin` and `/usr/local/lib` and stay out of checkpoints.

Rebuild the image when updating the image setup, and retain the previous
image ID with the previous core release for rollback. Existing running sandboxes
keep their current image until normal replacement. Do not delete image IDs still
used by running deployments or retained rollback releases.

For an isolated provider smoke test after the build:

```bash
MODAL_APP_NAME=qm-image-smoke MODAL_IMAGE=im-... node scripts/modal-live-smoke.mjs
```

This creates temporary sandboxes and terminates them afterward. It does not switch
production scopes.
