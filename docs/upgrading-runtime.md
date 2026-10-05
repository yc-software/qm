# Runtime upgrade compatibility

Pin the runtime source or image digest and deployment CLI together. Run migrations
before serving traffic, then qualify that exact candidate against an isolated copy
of the existing database. Keep the previous images and deployment configuration
available until the new revision has passed operational checks.

## Configuration changes

- `qm sandbox publish` and the `sandbox.image` runtime pin are retired.
  `qm sandbox build` remains available for validating local layer builds;
  `sandbox.baseImage` identifies their build input. Supply sandbox tools through
  deployment layers and configure the selected backend through its supported
  settings.
- `SANDBOX_SECONDARY_BACKEND` is retired. `SANDBOX_BACKEND` selects the primary
  backend; additional configured backends become available through their
  credentials and backend settings. Remove the old secondary setting.
- The `sandbox_routing` table, `SANDBOX_RESOURCES_ENABLED`, and the sandbox
  migration endpoints and agent action are retired. Sandbox resources are always
  on; scoped execution uses the selected sandbox resource. Disposable computers use
  that resource's provider, or the installation provider when no resource is selected. On upgrade,
  existing routes and `SANDBOX_SCOPE_BACKENDS` mappings are imported once as
  sandbox records so existing computers are preserved; afterwards
  `SANDBOX_SCOPE_BACKENDS` has no runtime effect. To move a scope to another
  provider, create a sandbox there, copy durable work via git or Files, and set
  it as the default. Keep credentials and provider settings for all legacy mappings
  until the import completes; an unconfigured provider needed by the import stops
  startup before any adoption state is written.
- Reach-denied Slack notifications are retired. Consult the audit log for denied
  requests.

## Database upgrades and rollback

Migration identifiers and SQL checksums retain their original meaning. An existing
checksum mismatch stops the upgrade; do not clear the migration ledger or edit its
checksums to bypass this check. A previously completed legacy webhook sweep is
adopted into the checksum ledger without disabling webhooks that an operator has
subsequently re-enabled.

The cron journal uses only `cron_fires`. Before upgrading, stop all workers
that write `crons.json.fireLog` or `cron_fire_log` and take a database recovery
point. Do not roll these older binaries alongside the new readers. Run:

```sh
node scripts/retire-cron-fire-history.ts
node scripts/retire-cron-fire-history.ts --apply
node scripts/backfill-session-origin.ts
```

The first command is read-only and exits nonzero if retained old fires are missing
or newer than the canonical journal. The second imports and verifies both legacy
sources in one locked transaction, removes the JSON fields and mirroring trigger,
and leaves the old table untouched. Run it once; re-importing an old table after
retention has pruned canonical history would resurrect expired fires.

Before serving the new readers, these read-only checks must return zero:

```sql
SELECT count(*) FROM crons WHERE json ? 'fireLog';
SELECT count(*) FROM sessions WHERE origin IS NULL
   OR (origin = 'cron' AND origin_id IS NULL);
SELECT count(*) FROM deliveries WHERE source_cron_id IS NULL
   AND COALESCE(substring(provenance->>'sourceThreadRef' FROM '^agent:main:cron:([^:]+)$'),
                substring(provenance->>'sourceThreadRef' FROM '^cron:([^:]+)(:.+)?$')) IS NOT NULL;
```

Run the retirement script without `--apply` again before promotion to verify every
retained legacy fire is present in `cron_fires`. Stored origin columns are now the
only source for SQL classification and delivery counts; new writes already stamp
them. There is no boot-time backfill or read-time inference.

Rolling back the runtime restores code and configuration, not database contents.
Older binaries do not display cron history written only to the new journal; those
records remain stored in `cron_fires`. Validate both old and new readers against the
candidate database before promotion, and retain a database recovery point for any
rollback that requires restoring data as well as code.
