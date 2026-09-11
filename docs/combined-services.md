# Combined web and sign-in services

QM deploys three application workloads: core, web-ui, and portal. The web-ui workload serves the chat interface and the admin module under `/admin`. Portal remains the public entry point and hosts the built-in auth broker when enabled. Slack remains in core.

The deployment's `services` list still declares capabilities. Keep `admin` to enable the admin module and `auth` to enable email sign-in. Their configuration remains under `env.admin`, `env.auth`, and the corresponding secret mappings. The CLI combines these into web-ui and portal respectively, rejects conflicting environment values, and preserves secret aliases. Omitting auth retains external OIDC sign-in. Logs and selective deployments for admin or auth resolve to the containing workload; the components cannot be released independently within a combined workload.

The modules retain separate handlers. Admin continues verifying signed portal identities and forwarding them to core, which authorizes every privileged action. Portal continues filtering inbound identity headers, checking sessions and CSRF, and gating admin access. The embedded auth broker listens only on `127.0.0.1:8099`, with its existing browser route allowlist exposed through portal. Token and JWKS endpoints stay on loopback. Auth signing keys are now available to the portal process; core's cloud permissions do not move into either surface workload.

## Upgrade an existing deployment

1. Record the existing release's source, image digests, configuration, secret versions, and workload sizes. Preserve database backups and the previous workloads for rollback.
2. Review the combined workloads' CPU and memory allocations, execution-role access to the union of their component secrets, and network access needed by the auth mail transport. Resolve conflicting environment or secret mappings before deployment.
3. Build web-ui and portal from the same source release. The CLI orders AWS and Fly deployments with web-ui before portal. Deploy the combined web-ui before changing portal's admin upstream to its `/admin` endpoint. Deploy portal with its embedded auth configuration and both names for the broker client secret. Keep the public issuer, callback URL, session keys, token secret, and signing JWK unchanged.
   On AWS, a secrets push uploads values but defers task activation when the live tasks still use the separate-service configuration. Complete the image rollout with `qm up`; keep existing signing and session secret values during this migration.

4. Verify signed-in chat, administrator and non-administrator access, login, logout, remembered sessions, and a live admin operation. Verify forged admin cookies are rejected, token endpoints are not publicly exposed, and streaming responses still work.
5. After qualification, scale the old admin and auth workloads to zero through the deployment provider. Docker containers can be stopped; Fly Machines and ECS services must have their old desired capacity explicitly reduced. The CLI does not destroy legacy workloads during this transition. Retain their images, configuration, and resource definitions until the rollback window closes.
6. Retire the obsolete infrastructure in a separate reviewed change. On AWS, new scaffolds contain only core, web-ui, and portal; existing `aws.services.admin` and `aws.services.auth` entries may remain temporarily to retain their Terraform resources. Do not blindly render and apply a plan that deletes rollback resources.

Rollback restores the old admin/auth capacity first, then the prior portal/web-ui image digests and routing configuration. This change introduces no database migration and does not rotate authentication keys.

The Helm chart treats admin/auth entries as module configuration and renders only their hosting workloads. Existing Helm releases require a reviewed upgrade because removing old Deployment resources happens with that upgrade. The separately deployable legacy image entrypoints remain available for rollback.

For source development, install root and web-ui dependencies. Portal-only package checks also need auth dependencies (`npm ci --prefix plugins/auth`). The local dev supervisor runs core, combined web, and portal; its localhost login bypass is for local wiring checks only.
