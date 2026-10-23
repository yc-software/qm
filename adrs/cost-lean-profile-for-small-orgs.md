# ADR proposal: Cost-lean Fly profile for small organizations

**State:** draft text only; not submitted upstream

**Observed against:** `@yc-software/qm@0.1.4` /
`7f2c916360f1797a8ff2a77ce2ce40c5fabab087`

## Context

The reference Fly topology is appropriate for a company, but a 1–10 person
organization pays for core, portal, auth, admin, and web UI continuously. The
interactive surfaces dominate the bill even when used for minutes per day.
The deployment contract already exposes `vms` size/memory overrides, but not
availability or private-addressing choices.

Today:

- web UI declares auto-stop but `min_machines_running = 1`;
- auth is already Flycast-private but auto-stop is false/min 1;
- admin is reached over `.internal` with no `http_service`, so Fly Proxy cannot
  wake it;
- the portal hardcodes admin's `.internal` upstream;
- `check --live` rejects a configured stopped workload even when scale-to-zero
  would be its declared healthy state;
- the external S3 hook accepts an endpoint secret, but the S3 client does not
  expose path-style addressing required by some compatible providers.

## Proposal

Add contract-v1 optional Fly fields (names illustrative):

```jsonc
{
  "fly": {
    "services": {
      "web-ui": { "autoStop": "stop", "minMachinesRunning": 0 },
      "auth": { "autoStop": "stop", "minMachinesRunning": 0 },
      "admin": {
        "privateAddress": "flycast",
        "autoStop": "stop",
        "minMachinesRunning": 0
      }
    },
    "objectStorage": {
      "mode": "external",
      "forcePathStyle": true
    }
  }
}
```

Keep core and portal always on by default. Continue to enforce that narrower
config cannot expose a private service publicly. For admin Flycast, derive the
portal upstream from the service registry rather than a hardcoded `.internal`
URL and deploy with `--flycast --no-public-ips`, matching web UI and auth.

Teach `check --live` the declared availability contract:

- an always-on service still requires a started healthy machine;
- a scale-to-zero service may be stopped if a correctly configured machine,
  image pin, identity, region, environment, Flycast service, auto-start, and
  min-zero policy all match;
- an optional `--wake` proof requests the private route through portal,
  verifies health after wake, and permits it to stop again.

For external S3, pass the path-style option into every core S3 client and make
`doctor`/`check --live` exercise the actual QM surface: put/get/delete,
multipart create/upload/complete/abort, list/sweep, and lifecycle installation
with an explicit nonfatal fallback result. `plan` must state whether `up` will
create Tigris or use pre-staged external storage; it must not silently create a
bucket when external mode is declared.

## Security invariants

- Portal remains the only public IP-bearing service.
- Core remains always on for queues, scheduler, and policy enforcement.
- Auto-start occurs only through Flycast/portal routes; no private service
  gains a public IP.
- Secrets remain provider-managed and absent from generated TOML and Git.
- Live verification does not treat “stopped” as healthy unless the committed
  contract explicitly selected scale-to-zero and all drift checks pass.

## Acceptance

1. Static contract fixtures cover supported/unsupported availability fields.
2. Generated Fly TOML matches the requested min/auto-stop/private-addressing
   policy in both directions.
3. Portal wakes web UI, auth, and admin from zero and no service receives a
   public IP.
4. `check --live` passes for an intentionally stopped min-zero surface and
   fails for a stopped always-on service or config drift.
5. External path-style S3 passes the complete compatibility probe; lifecycle
   unsupported is reported as fallback, not hidden.
6. Prescribed behavior remains the default for existing deployment
   directories.

## Consequence

Small organizations can preserve QM's topology and security model while paying
continuously only for core and portal. Larger organizations retain the current
always-on defaults. The deployment directory, not an edit to ignored generated
files, remains the portable source of truth.
