# Edge and harness

QM runs core as two services built from one image (`deploy/core/Dockerfile`), plus the optional egress proxy:

- **edge** (`node src/edge/main.ts`) serves HTTP. Its API on `PORT` (8080) is everything core served: `/v1`, the sandbox self-API, webhooks, Slack events, `/healthz`, and `/readyz`. With `portal` in `services` it also sets `PUBLIC_PORT=8000` and runs the public front door in-process: the portal handler on port 8000, the web UI (with the admin module under `/admin`), and, when `auth` is enabled, the built-in sign-in broker on `127.0.0.1:8099`. The edge only enqueues agent turns; it never runs them. Slack runs in the edge.
- **harness** (`node src/harness/main.ts`) claims queued turns from Postgres and runs them, along with crons and background sweeps. It serves only `/healthz` and `/readyz` on `PORT` and needs no ingress.

Both need the same database, model keys, sandbox and deploy provider credentials, and signing secrets. Both run migrations at boot under the advisory lock. Restarting the harness hands back only its own in-flight turns; restarting the edge never touches turns, so each target deploys and scales them as independent services. Each target keeps the drain time core had (300 seconds) on both.

The deployment's `services` list is unchanged: `core` is required and stands for both workloads. `portal` turns on the public front door, `web-ui` and `admin` the browser surfaces behind it, and `auth` email sign-in; `web-ui`, `admin`, and `auth` require `portal`. Configuration stays where it was. `env.core` and `secretEnv.core` reach both workloads. `env.slack`, `env.portal`, `env.web-ui`, `env.admin`, `env.auth`, and their secret mappings reach only the edge; the CLI merges them, rejects conflicting values between them, and lets `env.core` win. `PORT` and `PUBLIC_PORT` are managed by the target in every block. `qm logs core` shows both workloads; `qm logs slack` (or any edge-hosted name) shows the edge. `imageOverrides` is keyed by image: `core` pins the image both workloads run.

## Per target

- **docker**: containers `<prefix>-edge` and `<prefix>-harness` from one pulled or built image. The edge answers to `core` on the deployment network, so plugins keep `CORE_API_URL=http://core:8080`. Host port `basePort` maps the edge's API and `basePort + 1` its front door; the harness publishes no port. Both mount the data volume, the deployment layer, and, for local sandboxes, the Docker socket.
- **fly**: the edge keeps the `<appPrefix>-core` app, so its public IPs, certificates, and the `<appPrefix>-core.internal` address plugins use are unchanged; its `[http_service]` serves port 8000 publicly when the portal is on. The harness is a new `<appPrefix>-harness` app with no services or public IPs, health-checked on `/healthz`. Both run the same image (one build); the Fly `[processes]` command picks the entry point. `vms.core` sizes both; `vms.edge` or `vms.harness` overrides one. `qm up` attaches the Managed Postgres URL to both apps and copies the object storage credentials from the edge to the harness.
- **aws**: `aws.services.core` stays the one definition. The edge keeps core's ECS service, container name, target groups, and Service Connect name, so plugins keep `CORE_API_URL=http://core.<namespace>:8080`; with the portal on, the `portal` target group reaches its port 8000. The harness is a new ECS service, `<ecsService>-harness`, built once with the edge and run from the same image digest, task role, size, count, and stop timeout, with rolling deploys and no load balancer. The migration task and the canary run on the edge's task definition; `aws.backgroundWorkControl` governs the harness.
- **render**, **helm**, and **porter**: see `cli/templates/deployment/references/render.md`, `deploy/helm/README.md`, and `docs/porter.md`.

## Upgrade an existing deployment

1. Record the current release's image digests, configuration, and secret versions; keep database backups for rollback. No key rotation is involved; keep `PORTAL_SESSION_SECRET`, `PORTAL_IDENTITY_SECRET`, the auth token secret, and the signing JWK unchanged so sessions and the issuer survive.
2. Build or pin a release whose core image contains `src/edge/main.ts` and `src/harness/main.ts`. Older images cannot run either workload.
3. Push secrets (`qm secrets push`); secrets for core now land on both workloads, and portal, web, auth, and Slack secrets on the edge.
4. **Fly**: `qm up` creates the harness app and deploys both. When the deployment used separate web-ui, portal, admin, or auth apps, move the custom domain or certificate from `<appPrefix>-portal` to `<appPrefix>-core` (`fly certs add` on the core app, then DNS), set `publicUrl` to the new origin when it was the portal's `fly.dev` hostname, and destroy the old apps after the rollback window; the CLI no longer deploys or inspects them.
5. **Docker**: `qm up` removes the old core, web-ui, portal, admin, and auth containers and starts edge and harness; the data volume is reused.
6. **AWS**: update the vendored `infra/` from the current scaffold (version 4), render, and review the plan before applying; its `moved` blocks keep the existing core service as the edge rather than replacing it. Delete any `aws.services` entries for web-ui, portal, admin, or auth (the CLI names them), and on a shared ALB move `aws.services.portal.targetGroup` to `aws.services.core.targetGroup`. With `aws.backgroundWorkControl`, hand background ownership off before the first `qm up` that starts the harness.
7. Verify sign-in, signed-in chat with streaming, a Slack reply, a cron run, administrator access to `/admin`, and that the API port is not publicly reachable where it was not before.

Rollback redeploys the previous release's images and configuration.
