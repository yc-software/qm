# Prebuilt Modal connector image

Build the sandbox image before deploying core to keep package installation and image
building out of the first user turn. The image contains the same locked Composio SDK
bundle that core supplies to sandboxes without a baked image. Connector credentials
are supplied at runtime; none are used during this build.

From the matching source checkout, install dependencies with `npm ci`, configure Modal
authentication, then run:

```bash
MODAL_APP_NAME=qm npm run build:modal-image
```

The command eagerly builds the image on Modal and prints `MODAL_IMAGE=im-...` only
after the bundle's checksum and import checks pass. Save that exact image ID in the
core deployment's `MODAL_IMAGE` setting. Use the same Modal workspace and environment
for building and running; `MODAL_ENVIRONMENT` selects the SDK environment. The build
does not change running sandboxes or deploy core.

With no `MODAL_IMAGE` set during the build, the image starts from QM's pinned Node
base and installs its usual shell, Python, Git, curl, and archive utilities. To extend
an existing custom image, set `MODAL_IMAGE` to its registry reference (prefer an
immutable digest) or an existing Modal image ID. Custom bases must already contain
Node, npm, and QM's baseline utilities; this preserves the existing custom-image
contract. Building again from the same inputs uses Modal's layer cache.

The connector build uses `deploy/connector-sdk/package-lock.json` and the shared
bundle builder. The resulting SDK, checksum, and license notices live in
`/opt/qm/composio`, outside `/root`. Restoring a home snapshot therefore cannot hide
or replace image-installed dependencies. Core validates the baked artifact against
its own bundle and exposes the matching copy through the usual home launcher path;
an older image can use the runtime bundle fallback.

Native home checkpoints are directory snapshots of `/root`, so everything installed
under the home is captured again in every checkpoint. Deployment-layer tool files are
converged under `/usr/local/bin` and `/usr/local/lib` and stay out of checkpoints;
the runtime connector bundle fallback lands under `/root/.qm/composio` and adds about
1.3 MB to each checkpoint until `MODAL_IMAGE` points at a baked image, after which
only a symlink remains in the home. Set `MODAL_IMAGE` before enabling native
checkpoints on a deployment with many active users.

Rebuild the image when updating the SDK lockfile or builder, and retain the previous
image ID with the previous core release for rollback. Existing running sandboxes
keep their current image until normal replacement. Do not delete image IDs still
used by running deployments or retained rollback releases.

For an isolated provider smoke test after the build:

```bash
MODAL_APP_NAME=qm-image-smoke MODAL_IMAGE=im-... node scripts/modal-live-smoke.mjs
```

This creates temporary sandboxes and terminates them afterward. It does not switch
production scopes. Sprites and Modal deployments without a baked image continue to
use the shared runtime bundle installer.
