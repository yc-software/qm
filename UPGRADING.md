# Upgrading qm

This page lists what an operator has to change by hand when moving a deployment to a
newer qm. [Runtime upgrade compatibility](docs/upgrading-runtime.md) covers the general
procedure: pinning, migrations, qualification and rollback.

Before you start, take a database recovery point and keep the previous image and
deployment configuration available.

## Retired environment variables are ignored

qm reads a fixed set of environment variables and ignores everything else. A retired
name gives no warning or error, and it has no effect. If you set a variable below, the
setting stops applying when you upgrade. Rename it, or accept the new default.

Check every place your deployment sets environment: process env, the `env` blocks in
your deployment directory, and the secrets you push. To find retired names, use
something like this:

```sh
grep -R -n -E '\b(AGENT37|SUPERSERVE|AWS_SANDBOX|PORTER_SANDBOX|FLY)_[A-Z_]+|\b(E2B|MODAL|SPRITES|SMOLMACHINES|DO_AGENTS|LOCAL_SANDBOX)_(EGRESS_PROXY_URL|NAME_PREFIX|CPUS|MEMORY_MB|DISK_GB|[A-Z0-9_]*SNAPSHOT[A-Z0-9_]*|SANDBOX_TTL_SEC|MAX_LIFETIME_SEC|SANDBOX_TIMEOUT_SEC|REAP_IDLE_SEC|AUTOSTOP_SEC|IDLE_TIMEOUT_SEC)\b|\bSLACK_EVENTS_(MODE|PORT)\b' <your-deployment-dir>
```

### Renamed: sandbox settings are shared by every backend

Each sandbox backend used to read its own copy of these settings. They now share one
`SANDBOX_*` name. One value applies to whichever backend serves a machine. If you ran
several backends with different values, choose one. Each backend applies these settings
in its own way; [sandbox recovery](docs/sandbox-preservation.md) describes how.

| Retired                                                                                                                                                                                                       | Use instead                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `E2B_EGRESS_PROXY_URL`, `MODAL_EGRESS_PROXY_URL`, `SPRITES_EGRESS_PROXY_URL`, `SMOLMACHINES_EGRESS_PROXY_URL`, `DO_AGENTS_EGRESS_PROXY_URL`                                                                   | `SANDBOX_EGRESS_PROXY_URL`                             |
| `E2B_NAME_PREFIX`, `MODAL_NAME_PREFIX`, `SPRITES_NAME_PREFIX`, `SMOLMACHINES_NAME_PREFIX`, `DO_AGENTS_NAME_PREFIX`                                                                                            | `SANDBOX_NAME_PREFIX` (Porter app deploys read it too) |
| `MODAL_CPUS`, `SMOLMACHINES_CPUS`, `LOCAL_SANDBOX_CPUS`                                                                                                                                                       | `SANDBOX_CPUS`                                         |
| `MODAL_MEMORY_MB`, `SPRITES_MEMORY_MB`, `SMOLMACHINES_MEMORY_MB`, `LOCAL_SANDBOX_MEMORY_MB`                                                                                                                   | `SANDBOX_MEMORY_MB`                                    |
| `SMOLMACHINES_DISK_GB`                                                                                                                                                                                        | `SANDBOX_DISK_GB`                                      |
| `E2B_SNAPSHOT_INTERVAL_SEC`, `E2B_NATIVE_SNAPSHOT_INTERVAL_SEC`, `MODAL_SNAPSHOT_INTERVAL_SEC`, `MODAL_NATIVE_SNAPSHOT_INTERVAL_SEC`, `SMOLMACHINES_SNAPSHOT_INTERVAL_SEC`, `DO_AGENTS_SNAPSHOT_INTERVAL_SEC` | `SANDBOX_SNAPSHOT_INTERVAL_SEC`                        |
| `MODAL_REAP_IDLE_SEC`, `SMOLMACHINES_AUTOSTOP_SEC`, `DO_AGENTS_IDLE_TIMEOUT_SEC`, `E2B_SANDBOX_TTL_SEC`                                                                                                       | `SANDBOX_IDLE_PARK_SEC`                                |
| `E2B_MAX_LIFETIME_SEC`, `MODAL_SANDBOX_TIMEOUT_SEC`                                                                                                                                                           | `SANDBOX_MAX_LIFETIME_SEC`                             |

When a backend is selected, `SANDBOX_EGRESS_PROXY_URL` is the only egress setting. If it
is unset, core logs a warning at startup and sandboxes have unrestricted egress.

The following sandbox settings were removed with no replacement:

- **Portable home snapshots to S3:** `*_SNAPSHOT_S3_BUCKET`. Homes are recovered with each
  provider's own pause or checkpoint. Keep durable work in git or Files.
- **Endpoint and placement overrides:** `SPRITES_BASE_URL`, `SMOLMACHINES_BASE_URL`,
  `DO_AGENTS_API_BASE_URL`, `MODAL_REGIONS`, `DO_AGENTS_SIZE_SLUG`, `SMOLMACHINES_IMAGE`,
  `E2B_PROXY` and `SPRITES_EGRESS_PROXY_ADDITIONAL_URLS`.
- **Fixed behaviour:** `MODAL_NATIVE_SNAPSHOTS_ENABLED`, `MODAL_ROTATE_AFTER_SEC` and
  `MODAL_SNAPSHOT_RETENTION_SEC`. Modal native home checkpoints are always on.
- **Scope routing:** `SANDBOX_SCOPE_BACKENDS` and `SANDBOX_SECONDARY_BACKEND`. See
  [Runtime upgrade compatibility](docs/upgrading-runtime.md#configuration-changes).
- **Deleted backends:** every `AGENT37_*`, `SUPERSERVE_*`, `PORTER_SANDBOX_*` and
  `AWS_SANDBOX_*` variable. Porter and AWS remain app deploy providers through
  `PORTER_DEPLOY_*` and `AWS_DEPLOY_*`. `SANDBOX_BACKEND` now accepts `local`, `sprites`,
  `e2b`, `modal`, `smolmachines` and `do-managed-agents`. Core refuses to start when
  `SANDBOX_BACKEND` names a deleted backend.

### Slack events transport is inferred

`SLACK_EVENTS_MODE` is gone, and so is `eventsMode` in `SLACK_ACCOUNTS` entries. The
transport now follows from the credentials:

- If `SLACK_APP_TOKEN` (`xapp-…`) is set, qm uses Socket Mode.
- If only `SLACK_SIGNING_SECRET` is set, qm uses signed HTTP events.

An HTTP-events deployment that also sets `SLACK_APP_TOKEN` switches to Socket Mode.
Unset the app token to keep HTTP. `SLACK_EVENTS_PORT` is also gone: HTTP events are
served by the core process itself.

### Other renames

| Retired                                                                                                 | Use instead                                                                            |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `AGENT_API_URL` as core's own public API URL                                                            | `PUBLIC_API_URL`. Inside sandboxes, `AGENT_API_URL` is unchanged.                      |
| `DEPLOY_APPS_SESSION_SECRET`                                                                            | `PORTAL_SESSION_SECRET`                                                                |
| `AWS_DEPLOY_APPS_DOMAIN`                                                                                | `DEPLOY_APPS_DOMAIN`                                                                   |
| `AWS_REGION` / `AWS_DEFAULT_REGION` as the app-deploy region                                            | `AWS_DEPLOY_REGION` (default `us-west-2`)                                              |
| A Claude subscription token in `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN` | Save it as a keychain credential and name it in `CLAUDE_AUTH_CREDENTIAL`               |
| `CODEX_AUTH_FILE`                                                                                       | Save the ChatGPT login as a keychain credential and name it in `CODEX_AUTH_CREDENTIAL` |
| `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `OPENROUTER_BASE_URL`                                          | A custom model provider, or `MODEL_GATEWAY_URL`                                        |

`CAPABILITY_SECRET` and `PORTAL_IDENTITY_SECRET` no longer fall back to
`CORE_SIGNING_SECRET`. When `CORE_SIGNING_SECRET` is set, all three must be set and
distinct, or core refuses to start. `QM_ROLES` is gone: every process now serves the
API, the surfaces and turns.

### Removed outright

The following settings either had a single value that every deployment used or
belonged to features that were removed. The behaviour that remains is the old
default.

- **Fly.io hosting:** `FLY_*`.
- **Fixed postures and the Claude harness:** `HARNESS`, `HARNESS_SECURITY_POSTURE`,
  `HARNESS_SHARING_POSTURE`, `SECURITY_SCREEN`, `SECURITY_SCREEN_BACKEND`,
  `SECURITY_SCREEN_CLASSIFIER`, `CLAUDE_BIN` and `CLAUDE_MODEL`.
- **Postgres is required:** `SESSION_STORE`, `RUN_STORE`, `SNAPSHOT_STORE`,
  `TRANSFER_STORE` and `SECRETS_BACKEND`.
- **Memory:** `MEMORY_STRATEGY`, `MEMORY_PROVIDER_CONFIG`, `MEMORABLE_BACKEND`,
  `MEMORY_CAPTURE`, `MEMORY_CAPTURE_*` and `MEMORY_RECALL`.
- **Switches pinned to their deployed value:** `EAGER_PROVISION`, `EXECUTE_SCRATCH`,
  `FILES_DIRECT_UPLOADS_ENABLED`, `PI_SYSTEM_CACHE_SPLIT` and `SLACK_CONTEXT_SOURCE`.
- **Slack tuning:** `SLACK_ACK_CAP_MS`, `SLACK_CHANNEL_MEMBERS_TTL_MS`,
  `SLACK_MAX_PRIVATE_CHANNELS`, `SLACK_RECENT_MESSAGES`, `SLACK_USER_CACHE_TTL_MS`,
  `SLACK_USER_SNAPSHOT_TTL_MS` and `SLACK_COPILOT_BOT_TOKEN`.
- **Swarms, skill signing and Gmail push:** `SWARMS_ENABLED`, `SWARM_DEFAULTS`,
  `SKILL_SIGNING_SECRET` and `GMAIL_PUBSUB_*`.
- **Timeouts and intervals now fixed in code:** `BACKGROUND_JOB_TTL_SEC`,
  `BACKGROUND_JOB_TTL_MAX_SEC`, `EXEC_TIMEOUT_DEFAULT_SEC`, `EXEC_TIMEOUT_MAX_SEC`,
  `TURN_WALL_CLOCK_SEC`, `TURN_LEASE_WAIT_MS`, `HEARTBEAT_INTERVAL_MS`, `LEASE_TTL_MS`,
  `MONITOR_HEARTBEAT_SEC`, `RATE_LIMIT_PER_WINDOW`, `RATE_LIMIT_WINDOW_MS`,
  `BUDGET_WINDOW_MS`, `APPROVAL_SUMMARY_TIMEOUT_MS`, `SECURITY_SCREEN_TIMEOUT_MS`,
  `SANDBOX_CAPABILITY_TTL_HOURS`, `DEEP_IDLE_MACHINE_MS`, `DEV_IDLE_MACHINE_MS`,
  `DEPLOY_IDLE_TTL_MS`, `AWS_DEPLOY_ROTATE_AFTER_SEC` and `PORTER_DEPLOY_TTL_SEC`.
- **Other settings:** `ALLOW_UNAUTHENTICATED_CORE`, `DEPLOY_GIT_DIR`,
  `EGRESS_SERVICE_HOSTS`, `PI_CAPTURE_REQUESTS`, `PLUGIN_SKILLS_DIRS`, `SEED_SKILLS`,
  `SKILLS_SEED_DIR`, `SKILL_SYNC_POLL_MS`, `SECRETS_PREFIX` and `SURFACE_DEBUG_FOOTER`.

## Typed tables: unknown JSON keys stop the upgrade

Many stores used to keep each record as one JSON document in a `json` column. On first
boot, a newer release converts those tables in place, one migration per table. The
migration ids end in `/0001-typed`. Each conversion goes through these steps:

1. Add one column per known field.
2. Fill the new columns from the JSON.
3. Check every row.

The conversion keeps the `json` column. A trigger keeps the old and new forms in step,
so the previous image can still run against the database and rollback stays possible.
A later release drops the `json` column.

The check fails closed. A row stops the conversion in any of these cases:

- Its JSON has a key the release does not know.
- A required field is missing.
- A value does not convert back to the same JSON.
- The document is not an object.

Rows like this usually come from a fork that added fields, a newer build that was
rolled back, or a hand edit. qm does not drop data it does not understand.

**What you see:** startup exits with a Postgres error that names the table and the
first offending row:

```
<table>: row <id> does not convert to typed columns
```

Each migration runs in its own transaction. Tables converted earlier in the same boot
stay converted. The failing table is left exactly as it was, and the migration ledger
does not record it. The previous image keeps working, so you can roll back while you
investigate.

**How to fix it:**

1. Find the table's expected fields. Search the source for the table name or its
   `…/0001-typed` migration id. The table spec next to `mapToTableMigration` lists the
   columns. Fields named in `dropKeys` are discarded on purpose.
2. See which keys the table holds:
   ```sql
   SELECT k, count(*) FROM <table>, jsonb_object_keys(json) AS k GROUP BY k ORDER BY k;
   SELECT json FROM <table> WHERE id = '<id>';
   ```
3. Copy the rows you are about to change:
   `CREATE TABLE <table>_preupgrade AS SELECT * FROM <table>;`
4. Repair the data:
   - If no code needs a stray key, remove it:
     `UPDATE <table> SET json = json - '<key>' WHERE json ? '<key>';`
   - Delete a row that is junk.
   - If the data matters, carry it in your fork's table spec, or raise an issue
     upstream, before you upgrade.
5. Restart. The conversion reruns from the start and stops at the next bad row, if
   there is one. The key query in step 2 finds every unknown key at once, so you can
   fix them all before restarting.

Do not edit `qm_schema_migrations` to skip a conversion.

## Upgrading from older releases

Upgrade one release line at a time, and boot each step before moving on. Startup
refuses a database that is too old for the current schema baseline and names the
migrations it lacks. Boot the intermediate release that the message points to, then
continue. [Runtime upgrade compatibility](docs/upgrading-runtime.md#database-upgrades-and-rollback)
has the current requirements.
