# Upgrading legacy Fly deployments

The Fly provider uses isolated app networks and creates a new Machine before replacing a healthy release. Instances previously running the volume-backed Fly provider can retain their existing apps while new deployments use the current provider.

Set `FLY_LEGACY_DEPLOYMENT_IDS` to a comma-separated list of existing deployment UUIDs. This is an explicit, fixed compatibility inventory, including archived deployments. It is not a creation-date cutoff and must not be regenerated on startup. With an empty list, all deployments use the current provider.

The listed deployments retain their shortened Fly app names, `/data` volumes, Git reconciliation, automatic sleep/wake, and volume-preserving archive/restore. New deployments use the current Fly provider's full UUID app names, isolated networks, bundle limits, and idle cleanup. The current provider does not provision persistent app volumes.

## Cutover

1. Preserve the current image digests, application configuration, signing keys, database backup, Fly volume snapshots, and object-store release and Git archives. Validate recovery separately from the agent development instance.
2. Quiesce publication and inventory every deployment row, including archived and stopped rows. Verify that shortened IDs do not collide and match the existing Fly resources. Record the explicit UUID list in durable deployment configuration.
3. Preserve `FLY_DEPLOY_APP_PREFIX`, `FLY_ORG`, `FLY_REGION`, `FLY_DEPLOY_BASE_IMAGE`, `PUBLIC_API_URL`, `CAPABILITY_SECRET`, and the release bucket and prefix. Existing Machines download their release on every boot from `/v1/deploy-releases/:id`; the endpoint and old signatures must remain usable. Release objects live under the existing `deploy-releases/transfer/` prefix and are not ordinary expiring transfer blobs.
4. Stop the old core from accepting publication before the final inventory and replacement. Do not allow old and new cores to publish concurrently during this transition.
5. Verify an existing app wakes without republishing; then verify volume preservation, Git updates, rollback, and archive/restore with an isolated legacy test app. Verify a newly created app uses the current provider and never enters the legacy list.

## Retirement

Migrate each legacy app's persistent data and boot dependencies before removing its UUID from the list. Removing an ID does not move volumes, rename Fly apps, or delete old resources. New provider app names are different. Keep rollback resources until the migrated app has been validated, then retire them explicitly.

The legacy provider retains the earlier shared-network model; it is a compatibility path, not the default for newly published code. Do not add newly created deployment IDs to the legacy list merely to bypass current-provider bundle limits.
