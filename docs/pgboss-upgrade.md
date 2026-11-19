# pg-boss 12.37.1 upgrade

This dependency change fixes singleton/stately fetches that exclude runnable work using stale cached active keys. Upstream [PR957](https://github.com/timgit/pg-boss/pull/957) checks live active slots instead; the existing unique indexes still serialize concurrent claims. The old dependency is12.26.3, the first fixed release is12.37.1, and this change pins12.37.1 rather than taking unrelated later releases. This document describes the proposed code and isolated qualification, not a production rollout.

## Configuration and integration

The package requirement changes from `^12.26.1` to exact `12.37.1`; the lock resolves12.26.3→12.37.1. Required compatible resolutions also change cron-parser5.6.2→5.10.4, serialize-error13.0.1→13.1.0 and type-fest5.8.0→5.10.0, adding rrule-temporal2.2.8 and temporal-spec1.0.1. Existing pg8.23.1 and OpenTelemetry API resolution remain. There are no new QM environment settings, provider choices or user-facing controls.

Only the owner installer sets `bamIntervalSeconds:10` (the supported minimum; previously the library default60). It waits for all background migration (BAM) commands to complete, logs changing progress, reports/rejects asynchronous errors or recorded failures, and always shuts down its client/pool. It has no arbitrary startup deadline. Previously it returned while asynchronous indexes could remain pending. Failed records intentionally block installation; inspect and resolve the recorded migration failure before retrying. No runtime consumer fetch, monitor, cache or supervision interval changes. The upgraded library also enables automatic index-bloat detection/reindexing by default on supervising clients: it checks owned job indexes on a24-hour cadence with upstream size/density thresholds, and reports rather than rebuilding where ownership or backend capabilities do not permit it. Owner installation itself has supervision disabled. Vacuum monitoring adds warnings rather than running VACUUM. These upstream operational defaults are retained; no QM override or new setting is added. Consumers keep `migrate:false`; they cannot finish BAM themselves.

`installCronQueue(databaseUrl, schema="pgboss"):Promise<void>` retains its signature. Its fulfilled promise now proves background completion. QM job data, HTTP/model tool inputs and responses retain their shapes. The library gains upstream metadata/APIs; they are not added to QM routes. Its exported migration-plan `partitionTables` input changes from `string[]` to `{tableName:string,policy:QueuePolicy}[]`; QM does not call that exporter. Existing queue policies remain standard/short/singleton/stately/exclusive/key_strict_fifo; job states remain created/retry/active/completed/cancelled/failed.

The library now registers instances by default and heartbeats every30seconds, including clients using the custom database adapter. `instance` records process/worker/operational metadata, never job data or connection credentials. Custom adapters have null pool counts. Stopped rows are marked; quiet/stopped lives are pruned to20 per name/unnamed-host and1000 overall, with seven-day heartbeat retention. QM adds no override for these defaults.

OpenTelemetry instrumentation is enabled by default and uses already-registered global providers; no exporter, destination or credential is added. Context propagation into jobs remains off by default, so QM leaves `trace_context` null. The constructor option is not surfaced as a QM setting.

## Stored schema 37→45

All identifiers below use the default `pgboss` schema; the installer retains support for its existing validated schema argument. No columns or existing job payload keys are dropped, moved or renamed. Every pre-existing job column remains unchanged across the isolated populated upgrade. New job metadata is nullable and old rows receive null. Existing tables, primary/foreign keys, indexes and constraints remain unless explicitly listed below. Table rows marked retained describe their identical old/new type, nullability and default; added rows were absent before. `none` means no column default, distinct from a nullable value.

The job shape also applies to `job_common` and existing job partitions. Queue-stat changes propagate to existing date partitions and apply to future ones. There is no reinterpretation or publication of capture contents, grants, conversations or memory receipts.

### version

| Column               | Change   | Type                       | Nullable | Default |
| -------------------- | -------- | -------------------------- | -------- | ------- |
| `version`            | retained | `integer`                  | NO       | `none`  |
| `cron_on`            | retained | `timestamp with time zone` | YES      | `none`  |
| `bam_on`             | retained | `timestamp with time zone` | YES      | `none`  |
| `flow_on`            | retained | `timestamp with time zone` | YES      | `none`  |
| `reindex_on`         | added    | `timestamp with time zone` | YES      | `none`  |
| `monitor_backoff_on` | added    | `timestamp with time zone` | YES      | `none`  |

### queue

| Column                 | Change   | Type                       | Nullable | Default           |
| ---------------------- | -------- | -------------------------- | -------- | ----------------- |
| `name`                 | retained | `text`                     | NO       | `none`            |
| `policy`               | retained | `text`                     | NO       | `none`            |
| `retry_limit`          | retained | `integer`                  | NO       | `none`            |
| `retry_delay`          | retained | `integer`                  | NO       | `none`            |
| `retry_backoff`        | retained | `boolean`                  | NO       | `none`            |
| `retry_delay_max`      | retained | `integer`                  | YES      | `none`            |
| `expire_seconds`       | retained | `integer`                  | NO       | `none`            |
| `retention_seconds`    | retained | `integer`                  | NO       | `none`            |
| `deletion_seconds`     | retained | `integer`                  | NO       | `none`            |
| `dead_letter`          | retained | `text`                     | YES      | `none`            |
| `partition`            | retained | `boolean`                  | NO       | `none`            |
| `table_name`           | retained | `text`                     | NO       | `none`            |
| `deferred_count`       | retained | `integer`                  | NO       | `0`               |
| `queued_count`         | retained | `integer`                  | NO       | `0`               |
| `ready_count`          | retained | `integer`                  | NO       | `0`               |
| `warning_queued`       | retained | `integer`                  | NO       | `0`               |
| `active_count`         | retained | `integer`                  | NO       | `0`               |
| `failed_count`         | retained | `integer`                  | NO       | `0`               |
| `total_count`          | retained | `integer`                  | NO       | `0`               |
| `ready_history`        | retained | `integer[]`                | NO       | `'{}'::integer[]` |
| `heartbeat_seconds`    | retained | `integer`                  | YES      | `none`            |
| `notify`               | retained | `boolean`                  | NO       | `false`           |
| `singletons_active`    | retained | `text[]`                   | YES      | `none`            |
| `monitor_on`           | retained | `timestamp with time zone` | YES      | `none`            |
| `maintain_on`          | retained | `timestamp with time zone` | YES      | `none`            |
| `created_on`           | retained | `timestamp with time zone` | NO       | `now()`           |
| `updated_on`           | retained | `timestamp with time zone` | NO       | `now()`           |
| `monitor_claim_on`     | added    | `timestamp with time zone` | YES      | `none`            |
| `created_delta`        | added    | `integer`                  | NO       | `0`               |
| `completed_delta`      | added    | `integer`                  | NO       | `0`               |
| `failed_delta`         | added    | `integer`                  | NO       | `0`               |
| `delta_on`             | added    | `timestamp with time zone` | YES      | `none`            |
| `delta_seconds`        | added    | `integer`                  | YES      | `none`            |
| `blocked_count`        | added    | `integer`                  | NO       | `0`               |
| `wait_bins`            | added    | `integer[]`                | YES      | `none`            |
| `run_bins`             | added    | `integer[]`                | YES      | `none`            |
| `ready_oldest_seconds` | added    | `integer`                  | YES      | `none`            |

### schedule

| Column        | Change                     | Type                       | Nullable | Default        |
| ------------- | -------------------------- | -------------------------- | -------- | -------------- |
| `name`        | retained                   | `text`                     | NO       | `none`         |
| `key`         | retained                   | `text`                     | NO       | `''::text`     |
| `cron`        | retained                   | `text`                     | NO       | `none`         |
| `timezone`    | default none → 'UTC'::text | `text`                     | YES      | `'UTC'::text`  |
| `data`        | retained                   | `jsonb`                    | YES      | `none`         |
| `options`     | retained                   | `jsonb`                    | YES      | `none`         |
| `created_on`  | retained                   | `timestamp with time zone` | NO       | `now()`        |
| `updated_on`  | retained                   | `timestamp with time zone` | NO       | `now()`        |
| `kind`        | added                      | `text`                     | NO       | `'cron'::text` |
| `last_job_id` | added                      | `uuid`                     | YES      | `none`         |

### job

| Column                 | Change   | Type                          | Nullable | Default                           |
| ---------------------- | -------- | ----------------------------- | -------- | --------------------------------- |
| `id`                   | retained | `uuid`                        | NO       | `gen_random_uuid()`               |
| `name`                 | retained | `text`                        | NO       | `none`                            |
| `priority`             | retained | `integer`                     | NO       | `0`                               |
| `data`                 | retained | `jsonb`                       | YES      | `none`                            |
| `state`                | retained | `pgboss.job_state`            | NO       | `'created'::pgboss.job_state`     |
| `retry_limit`          | retained | `integer`                     | NO       | `2`                               |
| `retry_count`          | retained | `integer`                     | NO       | `0`                               |
| `retry_delay`          | retained | `integer`                     | NO       | `0`                               |
| `retry_backoff`        | retained | `boolean`                     | NO       | `false`                           |
| `retry_delay_max`      | retained | `integer`                     | YES      | `none`                            |
| `expire_seconds`       | retained | `integer`                     | NO       | `900`                             |
| `deletion_seconds`     | retained | `integer`                     | NO       | `604800`                          |
| `singleton_key`        | retained | `text`                        | YES      | `none`                            |
| `singleton_on`         | retained | `timestamp without time zone` | YES      | `none`                            |
| `group_id`             | retained | `text`                        | YES      | `none`                            |
| `group_tier`           | retained | `text`                        | YES      | `none`                            |
| `start_after`          | retained | `timestamp with time zone`    | NO       | `now()`                           |
| `created_on`           | retained | `timestamp with time zone`    | NO       | `now()`                           |
| `started_on`           | retained | `timestamp with time zone`    | YES      | `none`                            |
| `completed_on`         | retained | `timestamp with time zone`    | YES      | `none`                            |
| `keep_until`           | retained | `timestamp with time zone`    | NO       | `(now() + '336:00:00'::interval)` |
| `output`               | retained | `jsonb`                       | YES      | `none`                            |
| `dead_letter`          | retained | `text`                        | YES      | `none`                            |
| `policy`               | retained | `text`                        | YES      | `none`                            |
| `heartbeat_on`         | retained | `timestamp with time zone`    | YES      | `none`                            |
| `heartbeat_seconds`    | retained | `integer`                     | YES      | `none`                            |
| `blocked`              | retained | `boolean`                     | NO       | `false`                           |
| `blocking`             | retained | `boolean`                     | NO       | `false`                           |
| `pending_dependencies` | retained | `integer`                     | NO       | `0`                               |
| `source_name`          | retained | `text`                        | YES      | `none`                            |
| `source_id`            | retained | `uuid`                        | YES      | `none`                            |
| `source_created_on`    | retained | `timestamp with time zone`    | YES      | `none`                            |
| `source_retry_count`   | retained | `integer`                     | YES      | `none`                            |
| `source_output`        | added    | `jsonb`                       | YES      | `none`                            |
| `source_root_id`       | added    | `uuid`                        | YES      | `none`                            |
| `trace_context`        | added    | `jsonb`                       | YES      | `none`                            |
| `upsert_by_key`        | added    | `boolean`                     | YES      | `none`                            |

### queue_stats

| Column                 | Change   | Type                       | Nullable | Default             |
| ---------------------- | -------- | -------------------------- | -------- | ------------------- |
| `id`                   | retained | `uuid`                     | NO       | `gen_random_uuid()` |
| `name`                 | retained | `text`                     | NO       | `none`              |
| `deferred_count`       | retained | `integer`                  | NO       | `0`                 |
| `queued_count`         | retained | `integer`                  | NO       | `0`                 |
| `ready_count`          | retained | `integer`                  | NO       | `0`                 |
| `active_count`         | retained | `integer`                  | NO       | `0`                 |
| `failed_count`         | retained | `integer`                  | NO       | `0`                 |
| `total_count`          | retained | `integer`                  | NO       | `0`                 |
| `captured_on`          | retained | `timestamp with time zone` | NO       | `now()`             |
| `created_delta`        | added    | `integer`                  | YES      | `none`              |
| `completed_delta`      | added    | `integer`                  | YES      | `none`              |
| `failed_delta`         | added    | `integer`                  | YES      | `none`              |
| `delta_seconds`        | added    | `integer`                  | YES      | `none`              |
| `delta_on`             | added    | `timestamp with time zone` | YES      | `none`              |
| `wait_bins`            | added    | `integer[]`                | YES      | `none`              |
| `run_bins`             | added    | `integer[]`                | YES      | `none`              |
| `ready_oldest_seconds` | added    | `integer`                  | YES      | `none`              |

### instance

| Column                 | Change | Type                       | Nullable | Default       |
| ---------------------- | ------ | -------------------------- | -------- | ------------- |
| `id`                   | added  | `uuid`                     | NO       | `none`        |
| `name`                 | added  | `text`                     | YES      | `none`        |
| `host`                 | added  | `text`                     | NO       | `none`        |
| `pid`                  | added  | `integer`                  | NO       | `none`        |
| `version`              | added  | `text`                     | NO       | `none`        |
| `node_version`         | added  | `text`                     | NO       | `none`        |
| `application_name`     | added  | `text`                     | YES      | `none`        |
| `heartbeat_seconds`    | added  | `integer`                  | NO       | `none`        |
| `supervise`            | added  | `boolean`                  | NO       | `none`        |
| `schedule`             | added  | `boolean`                  | NO       | `none`        |
| `migrate`              | added  | `boolean`                  | NO       | `none`        |
| `persist_queue_stats`  | added  | `boolean`                  | NO       | `none`        |
| `persist_warnings`     | added  | `boolean`                  | NO       | `none`        |
| `pool_max`             | added  | `integer`                  | YES      | `none`        |
| `pool_total`           | added  | `integer`                  | YES      | `none`        |
| `pool_idle`            | added  | `integer`                  | YES      | `none`        |
| `pool_waiting`         | added  | `integer`                  | YES      | `none`        |
| `workers`              | added  | `jsonb`                    | NO       | `'[]'::jsonb` |
| `metrics`              | added  | `jsonb`                    | YES      | `none`        |
| `config`               | added  | `jsonb`                    | NO       | `'{}'::jsonb` |
| `crash_restarts`       | added  | `integer`                  | NO       | `0`           |
| `crash_restarts_since` | added  | `timestamp with time zone` | YES      | `none`        |
| `started_on`           | added  | `timestamp with time zone` | NO       | `now()`       |
| `heartbeat_on`         | added  | `timestamp with time zone` | NO       | `now()`       |
| `stopped_on`           | added  | `timestamp with time zone` | YES      | `none`        |

### Indexes, constraints, functions and backfills

- v38 builds the runnable/unblocked key_strict_fifo covering index `job_i10(name,singleton_key,state DESC,created_on,id) INCLUDE(start_after)` on the shared job table and relevant partitions. It updates `create_queue` for new partitions.
- v39 adds nullable `version.reindex_on`.
- v40 backfills `queue.monitor_claim_on` from `monitor_on`; builds `job_i11(name,priority DESC,created_on,start_after)` for runnable/unblocked jobs before retiring `job_i5`. It updates `create_queue`.
- v41 labels existing recurrence expressions as `schedule.kind=rrule`, leaving other rows cron; converts null timezones to UTC and sets the UTC default. Non-null zones remain unchanged. `last_job_id` has no FK because jobs are retained independently. The new check is `kind IN ('cron','rrule')`.
- v42 adds stable `job_now():timestamptz` returning `pg_catalog.now()` and updates `create_queue` to use the schema clock. Existing timestamp defaults shown above remain as recorded in the catalog.
- v43 initializes queue delta counters to0; existing historical metric/source fields remain null. It adds partial `job_i12(source_root_id) WHERE source_root_id IS NOT NULL` and updates `create_queue`.
- v44 initializes `queue.blocked_count` to0; histograms, oldest-ready time and trace metadata remain null. It creates `instance` with `PRIMARY KEY(id)` and no initial rows; matching clients register afterward.
- v45 adds nullable `upsert_by_key` and unique `job_i13(name,singleton_key) WHERE state='created' AND upsert_by_key`; ordinary pre-existing jobs have null, so their rows are not rewritten. It updates `create_queue`.

Canonical job index names acquire the shared/partition table prefix. Existing unique active-singleton constraints remain in force. Background commands preserve build-before-drop ordering and must finish before installer success. Other existing constraints and enum variants are unchanged.

### Catalog index changes

These full definitions come from the populated-upgrade catalog. The generated partition name is from the invented `partition-upgrade` fixture; other partitions receive their own names. Unlisted definitions are unchanged.

Removed definitions:

```sql
CREATE INDEX jb94cc0909ad484b7bb521a29bb2b90c1806587f99040664fb240a2f3_i5 ON pgboss.jb94cc0909ad484b7bb521a29bb2b90c1806587f99040664fb240a2f3 USING btree (name, start_after) WHERE ((state < 'active'::pgboss.job_state) AND (NOT blocked));
CREATE INDEX job_common_i5 ON pgboss.job_common USING btree (name, start_after) WHERE ((state < 'active'::pgboss.job_state) AND (NOT blocked));
```

Added definitions:

```sql
CREATE UNIQUE INDEX instance_pkey ON pgboss.instance USING btree (id);
CREATE INDEX jb94cc0909ad484b7bb521a29bb2b90c1806587f99040664fb240a2f3_i11 ON pgboss.jb94cc0909ad484b7bb521a29bb2b90c1806587f99040664fb240a2f3 USING btree (name, priority DESC, created_on, start_after) WHERE ((state < 'active'::pgboss.job_state) AND (NOT blocked));
CREATE INDEX jb94cc0909ad484b7bb521a29bb2b90c1806587f99040664fb240a2f3_i12 ON pgboss.jb94cc0909ad484b7bb521a29bb2b90c1806587f99040664fb240a2f3 USING btree (source_root_id) WHERE (source_root_id IS NOT NULL);
CREATE UNIQUE INDEX jb94cc0909ad484b7bb521a29bb2b90c1806587f99040664fb240a2f3_i13 ON pgboss.jb94cc0909ad484b7bb521a29bb2b90c1806587f99040664fb240a2f3 USING btree (name, singleton_key) WHERE ((state = 'created'::pgboss.job_state) AND upsert_by_key);
CREATE INDEX job_common_i10 ON pgboss.job_common USING btree (name, singleton_key, state DESC, created_on, id) INCLUDE (start_after) WHERE ((state < 'active'::pgboss.job_state) AND (NOT blocked) AND (policy = 'key_strict_fifo'::text));
CREATE INDEX job_common_i11 ON pgboss.job_common USING btree (name, priority DESC, created_on, start_after) WHERE ((state < 'active'::pgboss.job_state) AND (NOT blocked));
CREATE INDEX job_common_i12 ON pgboss.job_common USING btree (source_root_id) WHERE (source_root_id IS NOT NULL);
CREATE UNIQUE INDEX job_common_i13 ON pgboss.job_common USING btree (name, singleton_key) WHERE ((state = 'created'::pgboss.job_state) AND upsert_by_key);
```

### New instance JSON

`workers` defaults to[] and contains one record per work call: `{id:string,queue:string,localConcurrency:number,batchSize:number,pollingIntervalSeconds:number|null,active:number,lastFetchedOn:string|null,lastJobEndedOn:string|null,lastErrorOn:string|null,options?}`. `options` records only explicitly configured includeMetadata, ignoreStartAfter, minPriority, maxPriority, localGroupConcurrency, groupConcurrency, heartbeatRefreshSeconds, perJobResults, transactional, transactionTimeoutSeconds, notifyPollingIntervalSeconds, burstWhenReadyExceeds and burstWhenBatchFull. Boolean options are includeMetadata, ignoreStartAfter, perJobResults, transactional and burstWhenBatchFull; the remaining scalar options are numbers. groupConcurrency is either a number or `{default:number,tiers?:Record<string,number>}`. It contains no job data or error body.

`metrics` is null before sampling or `{cgroup:1|2|null,cpu:number|null,cpuLimit:number,cpuThrottled:number|null,rss:number|null,heapUsed:number|null,heapLimit:number|null,memoryUsed:number|null,memoryLimit:number,loopDelay:number|null,loopDelayMax:number|null,loopUtilization:number|null}`. Rates cover the heartbeat interval; resource limits come from the container where available and otherwise the host.

`config` defaults to{} and records `{adapter:"custom"|"pg"}` plus defined constructor values from this allowlist: backend, max, useListenNotify, instanceHeartbeatSeconds, supervise, schedule, migrate, createSchema, superviseIntervalSeconds, maintenanceIntervalSeconds, monitorIntervalSeconds, queueCacheIntervalSeconds, bamIntervalSeconds, flowIntervalSeconds, reindex, reindexIntervalSeconds, monitorVacuum, clockMonitorIntervalSeconds, cronMonitorIntervalSeconds, cronWorkerIntervalSeconds, persistWarnings, warningRetentionDays, persistQueueStats, queueStatRetentionDays, warningSlowQuerySeconds, warningQueueSize. A restarted start attempt may add numeric startAttempt. Connection strings, passwords, certificates, credentials and arbitrary objects are excluded.

### Invented row examples

A previously stored queue job `{id:"00000000-0000-4000-8000-000000000002",name:"sample-queue",data:{note:"synthetic"},state:"retry",...allOtherExistingJobFields}` retains every old field/value and additionally has `{source_output:null,source_root_id:null,trace_context:null,upsert_by_key:null}`. The ellipsis stands for the retained columns listed in the job table, not a dropped field. The real qualification compared all old columns as JSON, retaining database timestamp precision.

A schedule `{name:"sample-queue",key:"legacy",cron:"RRULE:FREQ=DAILY",timezone:null,...retainedScheduleFields}` becomes the same row with `{kind:"rrule",timezone:"UTC",last_job_id:null}`. An ordinary cron becomes kind cron; existing non-null timezone values remain.

`instance` was absent. A new owner-process row gets a generated UUID, invented host `qa-host`, its actual pid/library/node versions, the installer flags migrate=true/supervise=false/schedule=false, nullable name/application_name/pool counts, JSON shapes above, crash_restarts=0, nullable crash_restarts_since, start/heartbeat times and later stopped_on. No user identity or conversation content is copied into it.

## Upgrade and rollback

1. Back up the entire database and preserve queue jobs together with application receipts/handoffs. For an isolated development instance, stop admission and drain active work before taking the backup. Do not restore only the queue while retaining newer application receipts.
2. Stop old consumers. Run the matching owner-role installer; it upgrades the schema and waits for BAM. Existing default grants cover new objects, but verify the application role before resuming work.
3. Require all BAM entries completed and no invalid managed indexes. Inspect recorded failures and progress if a build is blocked. Do not infer completion from version45 alone.
4. Start the matching build and verify a queued retry plus normal cron/delivery/capture processing. New and old binaries are not a supported mixed deployment: old startups reject45. Additive columns do not make an application-only rollback safe. Use a validated database compatibility/restore procedure while admission remains stopped.

No production upgrade is implied by this change. The existing development database must be backed up before adopting it; isolated scratch databases used for qualification were removed.

## Qualification

- A real-Postgres reproduction under12.26.3 recorded an active singleton key, failed its job to runnable retry and observed a fresh consumer claim0; refreshing stats allowed claim1.12.37.1 claims that retry immediately without clearing the stale stats.
- The actual proposed installer upgrades a populated37 database to45, preserving every old job column and payload at database JSON/timestamp precision. Cases include a deferred cron, runnable capture retry, completed delivery and active partitioned job. New nullable job fields are null. Schedule kind/timezone backfill matches the documented transformation.
- All9 background commands complete; no invalid indexes remain. Existing default grants allow new app-role operations; delivery/retry succeeds. The real custom adapter registers, heartbeats and marks its instance stopped without recording connection credentials. The old exact-schema validator rejects45.
- The committed installer regression fails with the previous helper because index builds remain absent; the new helper waits for both builds. Its same fixture also exercises an invalid DDL command, requiring a rejected installation and persisted failure while preserving cleanup.
- Run the affected cron-queue, delivery-job, recovery and startup tests, plus typecheck/lint. Live agent/native qualification and full CI remain separate gates; no credentialed integration coverage is inferred from isolated queue tests.

The generic upgrade-row seeder and the synthetic v0.1.16 fixture now use executable
no-op SQL (`SELECT 1`) for `pgboss.bam.command`, replacing the fixture's arbitrary
`upgrade-check` text. Pending BAM is executed by the installer, so arbitrary text
is invalid test data. Only that cell changes in the compressed historical-schema
fixture; its schema and all other row values remain intact. Runtime rejection of
invalid migration commands remains covered by the installer regression. This is
not a production data backfill or a command-skipping compatibility path.

Release-upgrade tests retain the complete relation, named-column/type/default,
constraint, index, policy and trigger snapshots. Application column order and
function definitions remain exact. Only pg-boss column order is canonicalized by
name; its function definition headers remain in the snapshot, preserving return
types, arguments, language, volatility, security and per-function settings. Its
body semantics are additionally checked through the pinned SDK's
`detectSchemaDrift()` after each migration/restart. This accommodates the SDK's
intentional fresh-construction versus incremental-migration ordering/formatting,
without dropping structural or function-attribute coverage. The stronger ordered
snapshot equality remains; only a redundant set-difference equality is removed.
