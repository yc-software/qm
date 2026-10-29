# Combined web and sign-in services

QM deploys three application workloads: core, web-ui, and portal. The web-ui workload serves the chat interface and the administrator settings under `/settings`; old `/admin` links redirect there. Portal remains the public entry point and hosts the built-in auth broker when enabled. Slack remains in core.

The deployment's `services` list still declares capabilities. Administrator settings are part of web-ui and need no entry; a configuration that still names `admin` in `services`, `env`, `secretEnv`, `imageOverrides`, or `aws.services` is rejected until that entry is removed. Keep `auth` to enable email sign-in. Its configuration remains under `env.auth` and the corresponding secret mappings. The CLI combines it into portal, rejects conflicting environment values, and preserves secret aliases. Omitting auth retains external OIDC sign-in. Logs and selective deployments for auth resolve to portal; the components cannot be released independently within a combined workload.

The web-ui server relays administrator requests to core with the signed portal identity, and core authorizes every privileged action. Portal continues filtering inbound identity headers and checking sessions and CSRF. The embedded auth broker listens only on `127.0.0.1:8099`, with its existing browser route allowlist exposed through portal. Token and JWKS endpoints stay on loopback. Auth signing keys are now available to the portal process; core's cloud permissions do not move into either surface workload.

## Upgrade an existing deployment

1. Record the existing release's source, image digests, configuration, secret versions, and workload sizes. Preserve database backups and the previous workloads for rollback.
2. Review the combined workloads' CPU and memory allocations, execution-role access to the union of their component secrets, and network access needed by the auth mail transport. Resolve conflicting environment or secret mappings before deployment.
3. Build web-ui and portal from the same source release. The CLI orders AWS routing transitions and Fly deployments with web-ui before portal. Ordinary AWS image updates can start both workloads together when the recorded and live cohorts are stable and their routing is unchanged. Missing or uncertain evidence preserves the ordered rollout. Deploy portal with its embedded auth configuration and both names for the broker client secret. Keep the public issuer, callback URL, session keys, token secret, and signing JWK unchanged.
   On AWS, a secrets push uploads values but defers task activation when the live tasks still use the separate-service configuration. Complete the image rollout with `qm up`; keep existing signing and session secret values during this migration.

4. Verify signed-in chat, administrator and non-administrator access to `/settings`, login, logout, remembered sessions, and a live administrator operation. Verify forged identity headers are rejected, token endpoints are not publicly exposed, and streaming responses still work.
5. After qualification, scale the old admin and auth workloads to zero through the deployment provider. Docker containers can be stopped; Fly Machines and ECS services must have their old desired capacity explicitly reduced. The CLI does not destroy legacy workloads during this transition. Retain their images, configuration, and resource definitions until the rollback window closes.
6. Retire the obsolete infrastructure in a separate reviewed change. On AWS, new scaffolds contain only core, web-ui, and portal; an existing `aws.services.auth` entry may remain temporarily to retain its Terraform resources. Remove `aws.services.admin` before upgrading to a release without the admin service, and retire its ECS service and repository separately. Do not blindly render and apply a plan that deletes rollback resources.

Rollback restores the old admin/auth capacity first, then the prior portal/web-ui image digests and routing configuration. This change introduces no database migration and does not rotate authentication keys.

The Helm chart treats the auth entry as module configuration and renders only its hosting workload; it rejects a `services.admin` entry. Existing Helm releases require a reviewed upgrade because removing old Deployment resources happens with that upgrade. The separately deployable legacy image entrypoints remain available for rollback.

For source development, install root and web-ui dependencies. Portal-only package checks also need auth dependencies (`npm ci --prefix plugins/auth`). The local dev supervisor runs core, combined web, and portal; its localhost login bypass is for local wiring checks only.
