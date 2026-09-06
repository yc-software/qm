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
- Reach-denied Slack notifications are retired. Consult the audit log for denied
  requests.

## Database upgrades and rollback

Migration identifiers and SQL checksums retain their original meaning. An existing
checksum mismatch stops the upgrade; do not clear the migration ledger or edit its
checksums to bypass this check. A previously completed legacy webhook sweep is
adopted into the checksum ledger without disabling webhooks that an operator has
subsequently re-enabled.

The cron journal imports existing `cron_fire_log` history into `cron_fires` and
continues importing writes from older workers during a rolling upgrade. History
retention also removes expired entries from the legacy table, preventing a later
restart from importing them again. The legacy table remains available for older
binaries.

Rolling back the runtime restores code and configuration, not database contents.
Older binaries do not display cron history written only to the new journal; those
records remain stored in `cron_fires`. Validate both old and new readers against the
candidate database before promotion, and retain a database recovery point for any
rollback that requires restoring data as well as code.
