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

## Settings

| Variable                       | Default     | Purpose                                                                           |
| ------------------------------ | ----------- | --------------------------------------------------------------------------------- |
| `SUPERSERVE_API_KEY`           | Required    | Team API key, held by core.                                                       |
| `SUPERSERVE_TEMPLATE`          | Required    | Ready template name.                                                              |
| `SUPERSERVE_BASE_URL`          | SDK default | API endpoint override.                                                            |
| `SUPERSERVE_NAME_PREFIX`       | `qm`        | Namespace for scope discovery.                                                    |
| `SUPERSERVE_HOME_DIR`          | `/root`     | Guest home; workspace is `<home>/workspace`.                                      |
| `SUPERSERVE_RETENTION_SEC`     | `2592000`   | Delete the sandbox after this many continuous seconds paused; at most 30 days.    |
| `SUPERSERVE_EGRESS_ALLOW`      | Unset       | Comma-separated outbound allow rules: IPs, CIDRs, or domain patterns.             |
| `SUPERSERVE_EGRESS_DENY`       | Unset       | Comma-separated outbound deny rules: IPs and CIDRs only.                          |
| `SUPERSERVE_CONFIG_GENERATION` | Automatic   | Explicit rollout sequence.                                                        |
| `SANDBOX_TIMEOUT_SEC`          | `600`       | Default command deadline in seconds.                                              |
| `BACKGROUND_JOB_TTL_MAX_SEC`   | `3600`      | Also the continuous active-time ceiling of a sandbox before Superserve pauses it. |

Superserve's `timeoutSeconds` bounds continuous active time from the last resume,
not inactivity, and a command still running when it elapses is paused mid-run. QM
therefore pauses a scope sandbox itself when the last handle sharing it closes,
resumes it on the next provision, and sets the provider ceiling to
`BACKGROUND_JOB_TTL_MAX_SEC` (at most seven days) as a backstop for lost cores. A
teardown that leaves background work running skips the pause. Processes survive
pause and resume. Scratch sandboxes are deleted when their last local handle
closes, with the ceiling and a one-day retention as cleanup fallbacks.

Egress rules are enforced by Superserve outside the guest. A sandbox reaches any
public address until `SUPERSERVE_EGRESS_DENY` names `0.0.0.0/0`, which turns
`SUPERSERVE_EGRESS_ALLOW` into a strict allowlist. Under that rule QM also allows
the resolvers Superserve sandboxes use (`1.1.1.1` and `8.8.8.8`) whenever a domain
pattern is present, and the core's `PUBLIC_API_URL` host so file staging keeps
working. Private, link-local, and loopback ranges are always blocked. Bare IPs read
back as `/32`.

Command output is limited to 2 MiB per stream; write larger results to files.
Guest restart and the optional browser engine are not supported.

## Updates and retention

QM rediscovers sandboxes by scope metadata after a restart and checks their actual
egress policy before reuse. Changing the template replaces existing scope
sandboxes and deletes their resident files. An egress change can also require
replacement when a paused sandbox cannot accept the update. Export needed files
before either change.

A sandbox that remains paused for `SUPERSERVE_RETENTION_SEC` is automatically
deleted, including its disk. Explicit scope destruction also deletes the disk. A
sandbox Superserve reports as `failed` (it could not boot or resume) is deleted
when QM next lists the scope, and the next provision creates a replacement.

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
