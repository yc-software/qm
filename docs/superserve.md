# Superserve agent sandboxes

The `superserve` backend runs each QM scope in a sandbox with a persistent workspace,
file transfers, and background process sessions. Paused sandboxes resume on use.

## Configure

Build and verify an [agent template](../superserve/templates/README.md), then set:

```sh
SANDBOX_BACKEND=superserve
SUPERSERVE_API_KEY=your-superserve-api-key
SUPERSERVE_TEMPLATE=qm-agent-0.1.0
SANDBOX_NAME_PREFIX=my-qm
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
      "SANDBOX_NAME_PREFIX": "my-qm"
    }
  }
}
```

`env.core.SANDBOX_BACKEND` overrides `sandbox.backend`. Agents and admins select Superserve per
scope by creating a Superserve sandbox and setting it as the default.

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

| Variable                   | Default  | Purpose                                                                      |
| -------------------------- | -------- | ---------------------------------------------------------------------------- |
| `SUPERSERVE_API_KEY`       | Required | Team API key, held by core.                                                  |
| `SUPERSERVE_TEMPLATE`      | Required | Ready template name.                                                         |
| `SANDBOX_NAME_PREFIX`      | `qm`     | Namespace for scope discovery.                                               |
| `SANDBOX_IDLE_PARK_SEC`    | `900`    | Active-time limit before automatic pause, not an inactivity timer.           |
| `SANDBOX_EGRESS_PROXY_URL` | Unset    | When set, sandboxes may reach only the proxy host; otherwise egress is open. |
| `SANDBOX_TIMEOUT_SEC`      | `600`    | Default command deadline in seconds.                                         |

The guest home is `/root` and the workspace is `/root/workspace`.

Ending a turn pauses its sandbox; the next command or turn resumes it with its
disk intact. Background work keeps it running up to QM's configured maximum
background job lifetime instead. Scratch sandboxes are deleted when their last
local handle closes, with time limits as a cleanup fallback. Restarting the
computer pauses and resumes the same sandbox.

Command output is limited to 2 MiB per stream; write larger results to files.
The optional browser engine is not supported.

## Updates and retention

QM rediscovers sandboxes by scope metadata after a restart and checks their actual
egress policy before reuse. Changing the template replaces existing scope
sandboxes and deletes their resident files. An egress change can also require
replacement when a paused sandbox cannot accept the update. Export needed files
before either change.

A sandbox that remains paused for 30 days is automatically deleted, including its
disk. Explicit scope destruction also deletes the disk.

Automatic configuration ordering assigns a generation to each build and
configuration. Older instances cannot overwrite, pause or replace a sandbox a
newer configuration already adopted. A rollback reuses the earlier generation,
so it leaves sandboxes the newer generation adopted as they are.

## Tests

Backend tests run without an account:

```sh
node --experimental-test-module-mocks --test test/superserve-*.test.ts
```

The template verifier requires an API key and creates a temporary sandbox.
