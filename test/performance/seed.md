# Production-shaped synthetic fixtures

The seeder reads aggregate measurements at runtime. Production profiles and generated manifests belong outside the repository. No production message text, identities, credentials, or hostnames are required.

First inspect a deterministic plan:

```sh
node test/performance/seed.ts \
  --profile /private/usage-profile.json \
  --profile /private/usage-payloads.json \
  --profile /private/usage-storage.json \
  --scale 0.01 --plan-only --manifest /private/fixture-plan.json
```

Create a new isolated database whose name starts with `qm_perf_`. Keep the application stopped while seeding. Supply its connection URL through a dedicated environment variable, then run:

```sh
node test/performance/seed.ts \
  --profile /private/usage-profile.json \
  --profile /private/usage-payloads.json \
  --profile /private/usage-storage.json \
  --scale 0.01 \
  --database-url-env QM_PERF_DATABASE_URL \
  --database-name qm_perf_diagnostic \
  --manifest /private/fixture.json
```

The target must have no application relations or other connected clients. An already migrated database is rejected. The seeder never drops a database, truncates an existing application, falls back to `DATABASE_URL`, starts QM workers, or invokes a model. If seeding fails, the marker remains `seeding`; discard that disposable database and start with a new one. Output files use exclusive creation to protect an existing manifest.

Use `ORG_ID=perf` when booting the isolated application. The manifest names the synthetic admin and participant cohorts. Authentication is supplied separately by the live test runner. All generated domains end in `.invalid`.

The application schema comes from the current exported store migrations and the installed pg-boss construction plans. The manifest retains every measured relation and its row/byte estimates. Nonempty relations must have verified seeded counts or a reviewed exclusion with a reason; unclassified relations block the count gate. Optional `fixture_inventory_dispositions` supplies explicit exclusions. Runtime leases, external provider state and historical archives require separate evidence or explicit limits; exclusion never establishes endpoint coverage.

Scale `1` requests the complete supplied table cardinalities. These targets may be database estimates; the manifest labels that limitation. Smaller scales preserve participant cohorts and enough visible conversations to exercise their histories, while reducing historical rows. Dense and long transcripts remain large. Such runs are diagnostic and always unqualified.

Entry counts are fitted to measured surface, turn and scope-history distributions while preserving totals. Principal memberships and admin scope histories are separate cohorts. Payload size banks have 1024 buckets per measured kind and fit measured means, quantiles and maxima together. Serialized envelope bytes count toward those sizes. Visible text uses its own size and newline measurements; the remaining bytes are nonrendered context. Assistant payloads preserve the observed fraction without visible text. Optional exact search counts supersede stale table estimates: user/text quotas and assistant visibility are calibrated, then the application's real write-through trigger builds the search table. Independent snapshot times remain a qualification concern.

Optional `tape_distribution` rows (`kind`, `frequency`) and `canonical_tape_entries` (`rows`) preserve measured tape-kind and canonical-index populations. Browser cases include complete canonical, legacy and mixed storage, with an explicit canonical-prefix boundary for pagination. Other canonical copies follow deterministic recent sessions. The seed checks both transcript readers with an authorized nonempty viewer, an unrelated viewer and a page spanning both stores. `channel_state` uses actual message bounds and directory rosters. Tool call IDs pair per-session ordinals rather than collapsing all cards onto one ID; sampled per-session type imbalances can leave orphan results.

Payload compression uses the measured stored/raw ratio. Calibrate representative banks with the production PostgreSQL version and TOAST compression setting before a full seed; the ratio alone does not establish physical parity. Optional `<kind>_storage_sample` rows supply `avg_payload_bytes` and `avg_stored_bytes`, including `tape-message`, `tape-annotation`, `tape-context_event`, and `memory`. Collect new measurements into separate immutable profiles and retain their query provenance; profile order contributes to the fixture identity.

The typed UI datasets use current source interfaces and durable-map migrations, including persistent policies, scopes, resources, tasks and their relationships. Optional `feature_flag_names` and `feature_flag_scope_counts` preserve aggregate enum and enabled-scope populations using only synthetic scopes. Retired flag names remain durable rows that the current runtime ignores. Selected paused inbox loops and harmless published skills populate actual user lists; unmeasured lifecycle distributions remain a qualification limitation. An optional profile containing `ui_payloads` rows (`table`, `payload_bytes`, `max_payload_bytes`, `avg_payload_bytes`, `avg_stored_bytes`) calibrates their serialized sizes. Credential padding is encrypted synthetic secret content; other UI maps use nonrendered fixture metadata. Ciphertext uses the application's encryption helper with a fixture-only key, so encryption nonces vary while identities and plaintext remain deterministic. Credential use is unsupported.

The manifest reports actual counts, entry and tape kinds, canonical tape rows, participant/scope histories, sampled payload storage, case sentinels, transcript-reader checks and relation sizes. Visible-text means, quantiles and markdown frequencies include explicit residuals when independent input marginals cannot fit together. It always starts `qualified: false`; `cardinalityMatched` describes only the count and inventory checks. A separate parity review must attest distributions, compression, storage, hardware, network, authorization and concurrent workload before qualification. Row-count equality alone does not establish production parity.

The fixture includes twelve restored-tab cases, a measured dense transcript, a long transcript, and an assistant sentinel directly before the long transcript's initial twenty-five-turn window. Files contain metadata only; opening, downloading or executing a tool against their contents is unsupported until the isolated instance supplies real bytes. Completed runs, disabled crons/monitors, paused loops, stopped deployments, revoked credential grants, delivered messages, completed queue jobs and finished process records provide read load without external execution. Workload replay supplies concurrent activity separately.

Run the focused planning and safety check with:

```sh
node --test test/performance/seed.test.ts
```
