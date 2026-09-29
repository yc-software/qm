# Controlled concurrent writes and run streams

`workload-provider.ts` implements a streaming Anthropic Messages protocol fixture. QM's existing `ANTHROPIC_BASE_URL` override can point at it, with a synthetic API key and the real Pi harness. The provider controls model-call count, first-delta delay, chunk pacing, generated output size and repeated-content fraction. Between calls it requests only QM's real `files` tool with `action: "read"` against an explicitly provisioned fixture file. It never calls another provider, selects an arbitrary tool, or executes a command.

`workload-producer.ts` submits signed `/v1/turns?async=1` requests and consumes the real run SSE endpoints. Arrivals use the independent scheduler in `workload.ts`; a run completing does not schedule the next arrival. Direct lanes create synthetic threads or select explicitly attested existing-history sessions. Native cron lanes create normal one-shot crons with absolute `firstFireAt`; the application scheduler claims and enqueues their turns. Every arrival has a unique idempotency key and generated input payload. Lanes can have different shapes, actors, rates, history cohorts and subscriber fanout. Optional synthetic egress events use the actual `/v1/egress-audit` ingestion API without making an outbound network request.

This is a **controlled envelope**, not an exact production trace. The current producer reports `qualified: false`, including when it successfully achieves its pressure bounds. Its direct web turns, existing-history lanes and native one-shot crons exercise those application paths. They do not reproduce Slack ingress/delivery, auxiliary model traffic, recurring-calendar schedules, sandbox work, provider inference, or external-tool CPU. History and cron coverage remain absent unless those lanes are configured and complete. Additional workload producers and independent resource/cost evidence must close those gaps before performance qualification. A test cannot convert these omissions into parity by clearing an operator-provided limitations array.

Do not compare complete model-response duration with the browser's one-second load objective. The producer intentionally holds runs open for measured model/tool wait durations while browser tests measure reading, navigating, rendering and usability during that work.

## Evidence and setup

Keep measured profiles, credentials, endpoint addresses and output outside the upstream repository. Construct normal and peak controlled envelopes from measured arrival/source counts, run duration distributions, LLM/tool counts, payload distributions, database counter deltas and time-weighted concurrency. Short current counter windows are not historical peak measurements. Per-class maximum minutes need not have happened simultaneously; combining them is a stress envelope and must be labeled accordingly. If historical SSE fanout is unavailable, run an explicitly chosen subscriber-capacity sweep and report the supported bound without asserting that it is the historical production mix.

The fixture manifest requires the ordinary seeder identity, `principals`, and a real API-readable guard case. Every multi-call shape also needs a provisioned file entry:

```json
{
  "workload": {
    "readFiles": [
      {
        "principalId": "perf-user@example.invalid",
        "scopeId": "personal:perf-user@example.invalid",
        "artifactId": "0123456789abcdef0123456789abcdef",
        "path": "shared/read.txt",
        "contentBytes": 4096,
        "contentSha256": "sha256-of-the-actual-stored-bytes"
      }
    ]
  }
}
```

Provision and verify those bytes through the isolated instance's normal durable file path before adding this evidence. Metadata-only file artifacts are insufficient. Match the measured payload and compressibility cohorts; repeatedly reading one tiny file cannot stand in for a heavy tool-result distribution. For each required file, preflight checks the live artifact identity, enabled state, owner scope, byte count, stored hash and actual ACL grant. It then authenticates as that synthetic principal, streams `/v1/files/:id/content`, hashes the returned bytes and retains the verified count/hash in JSONL. Missing, truncated, changed or inaccessible bytes fail before any workload mutation. This requires `portalIdentitySecretEnv`; metadata assertions alone cannot pass. Run streams reporting a failed tool result also fail.

Configure the isolated application's real Pi harness, the tested Anthropic model, `ANTHROPIC_BASE_URL` pointing at the twin and a synthetic `qm-perf-…` token. Route auxiliary model traffic deliberately: this twin rejects unmarked title, screening or other auxiliary calls, and any new provider error fails the pressure result. Use an isolated egress policy and an environment manifest proving provider routing; the producer's fixture checks do not prove network policy or resource parity. Do not replace the browser's application APIs with mocks.

Provider profile fields:

| Field                                      | Meaning                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `schemaVersion`, `fixtureId`               | `1` and the exact fixture identity                                                                        |
| `model`, `tokenEnv`                        | Actual selected model ID and environment variable containing the synthetic key                            |
| `host`, `port`                             | Listener; non-loopback bind needs exact `QM_PERFORMANCE_BIND_HOST`                                        |
| `shapes[].name`                            | Unique safe identifier, referenced by a producer lane                                                     |
| `modelCalls`                               | Number of actual model calls; intermediate calls request `files(action: "read")`                          |
| `inputBytes`, `outputBytes`                | Generated user input and text output per call; encoded envelopes add overhead                             |
| `delayMs`, `chunkBytes`, `chunkIntervalMs` | First-text wait, chunk size and subsequent chunk pacing                                                   |
| `repeatedFraction`                         | Fraction of generated bytes using repeated text, from zero to one; calibrate against observed compression |
| `readPath`                                 | Required real fixture-relative file for multi-call shapes                                                 |

Producer profile fields:

| Field                                                          | Meaning                                                                                                                                                   |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workload`                                                     | Ordinary `WorkloadProfile` with the core origin, empty `requests`, configured streams, timeouts, concurrency, duration and condition                      |
| `databaseUrlEnv`, `sourceSecretEnv`, `portalIdentitySecretEnv` | Environment variable names for the fixture database, source signer, and file-read portal identity signer                                                  |
| `providerUrl`                                                  | Origin of the provider twin; remote use needs exact `QM_PERFORMANCE_PROVIDER_ORIGIN`                                                                      |
| `warmupMs`                                                     | Arrival window before measured arrivals begin; warmup runs remain active while they finish                                                                |
| `guardCase`                                                    | `sessionId`, `principalId`, `expectedVisibleText` present in both the manifest database and core API                                                      |
| `lanes[]`                                                      | `name`, `shape`, `ratePerSecond`, seeded `principalId`, `origin` (`direct` or `cron`), `subscribers` per run                                              |
| `lanes[].arrivals`                                             | Optional `{warmup: number[], measured: number[]}` ordered millisecond offsets, with `ratePerSecond: 0`; native cron slots use those same absolute offsets |
| `egressEventsPerSecond`                                        | Optional independent rate of real egress audit insertions                                                                                                 |
| `evidence`                                                     | `kind: "controlled-envelope"`, private measured-source SHA-256 values and explicit `limitations`                                                          |
| `bounds.running`                                               | `{min,max}` required throughout the sampled measured interval                                                                                             |
| `bounds.runEventsPerSecond`, `bounds.runBytesPerSecond`        | Measured dynamic run-stream data frame and wire-byte pressure bounds                                                                                      |
| `bounds.writes`                                                | Table name to `{inserts,updates,deletes}`, each with `{min,max}` rates per second                                                                         |

History lanes add `history: {name, entries: {min,max}, tapeBytes: {min,max}, sessions: [{sessionId,threadRef,expectedVisibleText}]}`. Bounds must come from the intended measured cohort; `tapeBytes` is the sum of serialized tape payload bytes. Preflight verifies each session through the actual API and the isolated database, including active membership, personal scope, nonempty user history, row/byte bounds and idle state. Each arrival repeats the database attestation and retains it. This observer cost is included in the controlled envelope. Sessions rotate deterministically by planned arrival ordinal, including warmup. The selected session is reserved until the run finishes. A busy, changed, missing, unauthorized or out-of-bounds session fails that arrival; there is no fresh-thread fallback or search for an easier idle session. Completed sessions may accumulate history, so choose sufficient sessions and bounds for the intended window and preserve all attestations.

Cron lanes add `cron: {scheduleLeadMs, maxFireDelayMs}` and cannot specify a history override. Each planned arrival creates a one-shot cron via `/v1/crons`, using the lane actor and explicit Pi model, without an outbound destination. Its absolute `firstFireAt` is the independent arrival slot plus the declared fixed lead. The lead is at least one second and smaller than the request timeout. Creation that misses this timestamp fails rather than moving the schedule. The producer never calls `/crons/:id/run`. It verifies the scheduled fire key/timestamp, maximum fire delay, corresponding PG-boss job, same-database run, SSE terminal state and exact LLM count; it disables the created cron afterward, including on failure. New one-shot definitions add configuration writes and do not reproduce a population of retained recurring schedules. Their fire windows are shifted by the declared lead; warmup, browser interval and measured pressure bounds must account for that shift and final draining.

`PRODUCER_TABLES` names all required counter tables, including shared prompt envelopes, crons and cron fires. Missing bounds or under/over-achieved pressure make `pass` false. Set tolerances deliberately from observation, counter statistics lag and test duration; do not widen them after seeing a failed candidate. For a sustained concurrency envelope, start measurement after enough warmup to populate the intended long-running cohort. Gauge checks are sampled once per second; raw records preserve the sampling times and observer errors. This is not a claim of continuously proven minimum concurrency between samples.

## Running

```sh
node test/performance/workload-provider.ts --profile /private/provider.json --fixture /private/fixture.json --out /private/provider-events.jsonl
```

Start QM with the fixture provider already configured, verify the intended environment and data parity, then explicitly set `QM_PERFORMANCE_PRODUCER_ORIGIN` to the isolated core origin. The producer checks the exact `qm_perf_*` database name, its ready marker, population hash, the provider's identity/profile hash, and a core API fixture sentinel before submitting turns. Every accepted run is also verified in that same database. The database observer connection is read-only and uses a five-second statement timeout.

```sh
node test/performance/workload-producer.ts --profile /private/producer.json --provider /private/provider.json --fixture /private/fixture.json --out /private/producer-events.jsonl
```

Run the ordinary HTTP/delivery-stream replay separately against the portal with its own measured lanes and authentic fixture cookies. Browser measurement must be contained in the successful measured intervals of **both** jobs. Only the producer's measured `measurement-start` announcement is printed; warmup readiness is not a browser measurement boundary. A missing/failed producer, missing pressure bounds, omitted source class, dropped stream or incomplete external-service parity must block qualification.

Output files are exclusive, owner-only JSONL. They preserve scheduled and achieved arrival counts, missed slots, full run completion, dynamic subscriber opens/closes, each consumed event's type/size, model timing/chunk/byte records, input and provider-request gzip sizes, periodic actual database running/queued counts, and table-counter rates. Authentication and application payloads are not logged. The generic scheduler duration for a producer request covers acceptance through terminal run evidence; `producer-accepted` records the separate API acceptance latency. Run failures trigger a best-effort abort of that producer-owned run and remain failures. Native cron cleanup is independently checked; an unresolved disable also fails the result.

The final `producer.coverage` reports history attestations, verified read files, native cron terminals and per-lane completion counts including warmup. `producer.qualificationGaps` retains fixed machine-readable source/protocol gaps plus missing history/cron coverage, independent of operator-supplied limitations. Every producer record remains `qualified: false`. These attestations are pressure and correctness evidence for a separate parity assessment, not a declaration of environment qualification.

Statistics snapshots may lag commits. Use sufficiently long steady measurement windows and retain raw snapshots/timestamps. Table writes include all work in the isolated database, so leave unrelated workloads off or declare and measure them. The provider must have spare compute capacity; its own delays or backpressure can otherwise become the bottleneck.

Focused tests exercise the real installed Anthropic protocol client against the twin, multi-call tool wire format, safety guards, SSE terminal/identity/tool failures, counter resets, busy-history failure without response-paced arrivals, absolute native-cron slots, and corrupted/missing durable bytes:

```sh
node --test test/performance/workload.test.ts test/performance/workload-producer.test.ts
```
