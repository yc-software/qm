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

The cron journal imports existing `cron_fire_log` history into `cron_fires` once
and then drops `cron_fire_log`.

Published 0.1.15 databases upgrade directly. Stop all older core and worker processes
before running the new migrations: this upgrade replaces `session_entries` with
`items`, and the old binary cannot read or write the converted schema. Back up the
database first. A rollback after this conversion requires restoring that backup as
well as the previous images; changing the image alone is insufficient.

The published upgrade restores session migrations `0034` through `0046` and run
migration `0010` with their historical identifiers and SQL checksums. The two
historical preparation backfills retain their original empty-statement checksums.
A recorded `sessions/store/0033-client-tools` or `runs/store/0009-claim-priority-index`
selects its respective upgrade chain. Fresh databases skip those chains and use
the existing base schemas. An installation that already applied the chain validates
its checksums and skips it. Databases older than those supported anchors remain
subject to the existing base-schema refusal; do not forge ledger entries.

| Existing data                                                              | Upgrade result                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions`, participant membership and display preferences                 | Kept; origin and last-user-activity backfilled; later existing migrations add session facts and retain active membership.                                                                                                                                  |
| `session_entries` and previously prepared `legacy_tape_steps`              | Converted by the historical items migration into `items`, keyed by `(tenant_id, session_id, seq)`; message text, tool call/result pairing, turn IDs and timestamps travel with each supported item. The legacy history and search tables are then dropped. |
| No `qm_tenant` / `qm_tenant_id()`                                          | Historical items migration creates the singleton UUID and function before the current session tenant backfill reads them.                                                                                                                                  |
| `runs`                                                                     | Kept; the original `0010` removes obsolete `turn_metrics`, and the existing base migration removes unused `tool_calls`.                                                                                                                                    |
| Saved turn requests, approval requests, run signals and Slack destinations | Historical conversion functions populate typed `origin`, `surfaceOrigin` and destination `account` fields before the retired-origin sweep checks them. Request rewrites commit in batches and can resume.                                                  |
| `qm_schema_migrations`                                                     | Existing IDs/checksums retained; completed upgrade steps are recorded. Restart skips them without copying history twice.                                                                                                                                   |

For example (invented), a `tool_result` row with payload
`{"callId":"22222222-2222-4222-8222-222222222222","result":"apples"}`
becomes a `ToolResult` item with the same sequence, `call_id` and `text = 'apples'`.
A request with `triggered: true` and a Slack `triggerDestination` becomes an
automation `origin` whose destination contains `account.id` and `account.workspace`.
No deployment settings or public API shapes are added by this compatibility path.

`test/postgres-published-upgrade.test.ts` loads the schema and migration ledger
produced by the published v0.1.15 source, adds synthetic conversation/run/directory
rows, invokes the real migration entrypoint, checks preserved history and preferences,
and runs the entrypoint again. It also resumes after the history-copy migration has
committed. The fixture contains no deployment data; its provenance and regeneration
procedure are in `test/fixtures/upgrades/README.md`.

Rolling back the runtime restores code and configuration, not database contents.
Older binaries do not display cron history written only to the new journal; those
records remain stored in `cron_fires`. Validate both old and new readers against the
candidate database before promotion, and retain a database recovery point for any
rollback that requires restoring data as well as code.
