# Web surfaces hosted by core

QM deploys one application workload, core, plus the optional egress proxy. With `portal` in `services`, core sets `PUBLIC_PORT=8000` and runs the public front door in-process: the portal handler on port 8000, the web UI server (with the admin module under `/admin`) on a loopback port, and, when `auth` is enabled, the built-in sign-in broker on `127.0.0.1:8099`. Core's API stays on `PORT` (8080) and is never the public listener. Slack also runs in core.

The deployment's `services` list still declares capabilities: `portal` turns on the public front door, `web-ui` and `admin` the browser surfaces behind it, and `auth` email sign-in. `web-ui`, `admin`, and `auth` require `portal`. Their configuration stays under `env.portal`, `env.web-ui`, `env.admin`, `env.auth`, and the corresponding secret mappings; the CLI merges it into core's environment, rejects conflicting values between those components, and lets `env.core` win. `PORT` and `PUBLIC_PORT` are managed by the target in every block. Logs and `--only` for a hosted name resolve to core.

The modules keep their separate handlers. The portal still filters inbound identity headers, checks sessions and CSRF, gates admin access, and signs the identity core verifies (`REQUIRE_SIGNED_PORTAL_IDENTITY=1`). Token and JWKS endpoints stay on loopback.

## Public ingress per target

- **docker**: host port `basePort + 1` maps to core's port 8000; `basePort` still maps core's API port for the local CLI.
- **fly**: the core app's `[http_service]` serves port 8000 publicly; other apps reach core's API over the private network at `<appPrefix>-core.internal:8080` as before.
- **aws**: the ALB route keyed `portal` (default `/*`, behind CloudFront) targets core's port 8000; core's ECS task maps both ports and Service Connect still publishes only 8080. The Terraform scaffold takes the port as `public_port`. On a shared ALB, `aws.services.core.targetGroup` names the front-door target group.

## Upgrade an existing deployment

1. Record the current release's image digests, configuration, and secret versions; keep database backups and the old workloads for rollback. No database migration or key rotation is involved; keep `PORTAL_SESSION_SECRET`, `PORTAL_IDENTITY_SECRET`, the auth token secret, and the signing JWK unchanged so sessions and the issuer survive.
2. Review core's CPU and memory: it now carries the surfaces the separate workloads ran.
3. Push secrets (`qm secrets push`); the portal, web, and auth secrets now land on core. On AWS a push defers task activation while the current deployment manifest still records separate web-ui, portal, admin, or auth workloads.
4. **AWS**: update the vendored `infra/main.tf` and `infra/variables.tf` from the current scaffold (the CLI refuses a portal deployment until `public_port` is declared), render, and review the plan. It moves the `portal` target groups and listener rule onto the core service, adds the public port to the services security group, and deletes the web-ui, portal, admin, and auth ECS services and ECR repositories. Rollback needs those repositories and their image digests, so keep them until the rollback window closes: before applying, take them out of Terraform state (for example `terraform state rm 'aws_ecr_repository.service["portal"]'`) so the apply leaves them in place, and delete them only after the window closes. The CLI rejects leftover `aws.services` entries for those names; delete them, and on a shared ALB move `aws.services.portal.targetGroup` to `aws.services.core.targetGroup`.
5. **Fly**: `qm up` deploys core with its public HTTP service and public IPs. Move the custom domain or certificate from `<appPrefix>-portal` to `<appPrefix>-core` (`fly certs add` on the core app, then DNS), and set `publicUrl` to the new origin when it was the portal's `fly.dev` hostname. Destroy the old web-ui, portal, admin, and auth apps after the rollback window; the CLI no longer deploys or inspects them.
6. **Docker**: `qm up` removes the deployment's old web-ui, portal, admin, and auth containers and runs core alone; the public front door is on `basePort + 1`.
7. Verify sign-in, logout, signed-in chat with streaming, administrator and non-administrator access to `/admin`, and that the API port is not publicly reachable.

Rollback redeploys the previous release's images and configuration, including the separate workloads.

The Helm chart and the Porter app files still run web-ui and portal as separate workloads, now built from the core image with their own entrypoints.
