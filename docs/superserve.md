# Superserve agent sandboxes

The `superserve` backend runs each QM scope in a sandbox with a persistent workspace,
file transfers, and background process sessions. Paused sandboxes resume on use.

## Configure

Build and verify an [agent template](../superserve/templates/README.md), then set:

```sh
SANDBOX_BACKEND=superserve
SUPERSERVE_API_KEY=your-superserve-api-key
SUPERSERVE_TEMPLATE=qm-agent-0.1.0
SUPERSERVE_NAME_PREFIX=my-qm
```

Store the API key as a core service secret. Production requires `DATABASE_URL` for
sandbox records, provisioning locks, and configuration ordering across instances.
Use a distinct name prefix for each independent deployment sharing a Superserve
team, including development instances.

For CLI deployments, add these fields to the deployment config and supply the API
key through the CLI's secret configuration:

```json
{
  "sandbox": { "backend": "superserve" },
  "env": {
    "core": {
      "SUPERSERVE_TEMPLATE": "qm-agent-0.1.0",
      "SUPERSERVE_NAME_PREFIX": "my-qm"
    }
  }
}
```

`env.core.SANDBOX_BACKEND` overrides `sandbox.backend`. To select Superserve for
individual scope kinds, use `SANDBOX_SCOPE_BACKENDS`; the same key, template, and
database requirements apply.

For local development, export the key and template and run
`npm run dev-instance -- --sandbox superserve`.

## Sandbox capacity

Sandboxes inherit CPU, memory, and disk capacity from their template. The agent
template builder defaults to 8 vCPUs, 16384 MiB (16 GiB) memory, and 32768 MiB
(32 GiB) disk. Override these with `--vcpu`, `--memory-mib`, and `--disk-mib` at
build time; there are no runtime resource-size settings. Existing sandboxes are
not resized by updating QM or rebuilding a template. Follow the [capacity rollout steps](../superserve/templates/README.md#increase-sandbox-capacity)
to build and verify a new template, preserve resident work, and replace sandboxes.

## Settings

| Variable                       | Default     | Purpose                                                                            |
| ------------------------------ | ----------- | ---------------------------------------------------------------------------------- |
| `SUPERSERVE_API_KEY`           | Required    | Team API key, held by core.                                                        |
| `SUPERSERVE_TEMPLATE`          | Required    | Ready template name.                                                               |
| `SUPERSERVE_BASE_URL`          | SDK default | API endpoint override.                                                             |
| `SUPERSERVE_NAME_PREFIX`       | `qm`        | Namespace for scope discovery.                                                     |
| `SUPERSERVE_HOME_DIR`          | `/root`     | Guest home; workspace is `<home>/workspace`.                                       |
| `SUPERSERVE_IDLE_PAUSE_SEC`    | `900`       | Active-time limit before pause, not an inactivity timer.                           |
| `SUPERSERVE_RETENTION_SEC`     | `2592000`   | Delete the sandbox after this many continuous seconds paused (30 days by default). |
| `SUPERSERVE_EGRESS_ALLOW`      | Unset       | Comma-separated outbound allow rules.                                              |
| `SUPERSERVE_EGRESS_DENY`       | Unset       | Comma-separated outbound deny rules.                                               |
| `SUPERSERVE_CONFIG_GENERATION` | Automatic   | Explicit rollout sequence.                                                         |
| `SANDBOX_TIMEOUT_SEC`          | `600`       | Default command deadline in seconds.                                               |

Ending a turn leaves its sandbox running until the active-time limit, so other
turns sharing it can continue. Background work can extend that limit to QM's
configured maximum background job lifetime. Scratch sandboxes are deleted when
their last local handle closes, with time limits as a cleanup fallback.

Command output is limited to 2 MiB per stream; write larger results to files.
Guest restart and the optional browser engine are not supported.

## Updates and retention

QM rediscovers sandboxes by scope metadata after a restart and checks their actual
egress policy before reuse. Changing the template replaces existing scope
sandboxes and deletes their resident files. An egress change can also require
replacement when a paused sandbox cannot accept the update. Export needed files
before either change.

A sandbox that remains paused for `SUPERSERVE_RETENTION_SEC` is automatically
deleted, including its disk. Explicit scope destruction also deletes the disk.

Automatic configuration ordering assigns a generation to each build and
configuration. Older instances cannot overwrite a newer sandbox configuration.
A rollback reuses the earlier generation: to apply it, set
`SUPERSERVE_CONFIG_GENERATION` to a strictly increasing rollout sequence and
continue using that sequence for subsequent deployments. Template and egress
changes during rollback have the same replacement behavior described above.

## Tests

Backend tests run without an account:

```sh
node --experimental-test-module-mocks --test test/superserve-*.test.ts
```

The template verifier requires an API key and creates a temporary sandbox.
