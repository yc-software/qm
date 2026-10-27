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
- The `sandbox_routing` table, `SANDBOX_RESOURCES_ENABLED`, and the sandbox
  migration endpoints and agent action are retired. Sandbox resources are always
  on; scoped execution uses the selected sandbox resource. Disposable computers use
  that resource's provider, or the installation provider when no resource is selected. Builds
  from 2026-10-02 to 2026-10-26 imported existing routes and `SANDBOX_SCOPE_BACKENDS`
  mappings once as sandbox records; later builds no longer carry that import, so a
  deployment older than 2026-10-02 must boot one of those builds first.
  `SANDBOX_SCOPE_BACKENDS` is ignored. To move a scope to another provider, create a
  sandbox there, copy durable work via git or Files, and set it as the default.
- Reach-denied Slack notifications are retired. Consult the audit log for denied
  requests.

## Database upgrades and rollback

Migration identifiers and SQL checksums retain their original meaning. An existing
checksum mismatch stops the upgrade; do not clear the migration ledger or edit its
checksums to bypass this check. Startup checks every recorded checksum, the pending
migrations and the baseline decision before it changes anything, so a refused upgrade
leaves the database as it was. When a released id has to change, the new definition
lists the old checksum in `acceptedChecksums` and a follow-up migration brings
databases that ran the old one to the same end state.

Migrations only expand the schema while an older image may still be rolled back to:
they add tables, columns and indexes and rewrite rows, but never drop what older code
still reads. Drops wait in `src/persistence/contract-migrations.ts` until a later
release registers them, once rollback to the images that need those objects is no
longer possible.

The schema starts from `src/persistence/schema-baseline.sql`, which folds every
migration released up to qm main 9be16d35. A new database gets the baseline, then the
later migrations. A database that already applied every folded migration, as any
deployment that has booted qm main 9be16d35 or later has, records `baseline/0001`
without changing anything and runs only the later migrations. An older database, from
any earlier release including those before the `qm_schema_migrations` ledger, first
runs the folded migrations it lacks, exactly as qm main 9be16d35 defined them
(`src/persistence/schema-baseline-chain.json`, in the order that release applied
them), then records `baseline/0001` and continues with the later migrations. On a
database from before qm main moved session history into `items`, that first boot copies
the whole history in one transaction and holds the migration lock until it finishes, so
expect it to take a while on a large database.

Rolling back the runtime restores code and configuration, not database contents.
Older binaries do not display cron history written only to the new journal; those
records remain stored in `cron_fires`. Validate both old and new readers against the
candidate database before promotion, and retain a database recovery point for any
rollback that requires restoring data as well as code.
