# Independent-arrival workload replay

`workload.ts` offers HTTP requests at configured times independently of response completion, and keeps configured SSE connections open and consumed throughout measurement. It accepts only an explicitly identified isolated performance fixture. It does not create that fixture or prove its deployment is isolated.

Run the focused scheduler/accounting check:

```sh
node --test test/performance/workload.test.ts
```

Run a workload with a fixture manifest emitted by the performance seeder:

```sh
node test/performance/workload.ts --profile /private/workload.json --fixture /private/fixture.json --out /private/workload-results.jsonl
```

The output file must not already exist. It is created with owner-only permissions. Each line is a standalone JSON record. Authentication headers and response/request content are not logged. Standard output announces `measurement-start` once streams are ready, then prints the final summary. Start browser samples after that announcement and finish them before `plannedFinishAt`; the verifier must reject samples outside this interval or joined to a failed workload.

For recorded arrivals, set a request's `ratePerSecond` to zero and provide `arrivalOffsetsMs`, an ordered array of integer offsets within `durationMs`. Equal offsets preserve bursts, and the first offset may be greater than zero. The list is authoritative: no implicit request is added at startup, and the reported target rate is its count divided by the window duration. Retain the source trace hash and its timestamp resolution; reconstructed within-minute timing is a stated assumption.

The profile format below deliberately disables traffic. Fill rates and stream counts from the measured usage envelope; zero means disabled, and a completely disabled profile is rejected. Keep profiles containing deployment details outside Git.

```json
{
  "schemaVersion": 1,
  "baseUrl": "http://127.0.0.1:8096",
  "fixtureId": "copy-from-fixture-manifest",
  "isolated": true,
  "externalEffectsDisabled": true,
  "mode": "diagnostic",
  "condition": "normal",
  "durationMs": 120000,
  "requestTimeoutMs": 10000,
  "maxConcurrency": 100,
  "maxStartDelayMs": 100,
  "streamConnectTimeoutMs": 10000,
  "requests": [
    {
      "name": "recent-conversations",
      "method": "GET",
      "path": "/api/sessions",
      "ratePerSecond": 0,
      "headersEnv": { "cookie": "QM_PERF_HEAVY_COOKIE" },
      "expectedStatuses": [200]
    }
  ],
  "streams": [
    {
      "name": "delivery-events",
      "path": "/api/deliveries/events",
      "connections": 0,
      "headersEnv": { "cookie": "QM_PERF_HEAVY_COOKIE" }
    }
  ]
}
```

Resolve the actual stream endpoint from the tested deployment before enabling it. The tool does not infer routes, actors, or production rates. `headers` holds static headers and `headersEnv` maps header names to environment variable names. Put credentials only in environment variables. Each request may supply a JSON `body`; the runner serializes it and defaults its content type to JSON. Expected statuses default to `[200]` and must be successful HTTP statuses. All redirects are rejected rather than followed. Request names and stream names must be unique.

Paths and string values inside JSON bodies support `{{cases.long.sessionId}}`, `{{cohorts.max.principalId}}`, and other scalar fixture-manifest paths. `{{runId}}` and `{{sequence}}` identify a run and a lane's arrival/connection index. Path substitutions are URL encoded; body substitutions remain strings. Distinct request lanes can use different synthetic fixture actors, methods, bodies, and rates for foreground API reads and safe background writes. A rate is arrivals per second: the first slot is at zero, and later slots are evenly spaced until the exclusive duration boundary. Over short windows, the discrete offered rate can differ from the configured rate by less than one arrival per window.

The fixture manifest must identify a `qm_perf_*` database and match the profile's `fixtureId`. `qualifying` mode additionally requires the manifest's `qualified` population verdict. Remote hosts require `QM_PERFORMANCE_ALLOWED_ORIGIN` to exactly match the explicit isolated HTTP origin. These checks prevent accidental target substitution; they do not remotely attest the running app's database, compute parity, egress policy, or credentials. Those are deployment/preflight responsibilities. `isolated` and `externalEffectsDisabled` are operator attestations. Known model-dispatch and surface-post routes are rejected for mutations. The runner has no LLM, Slack, or other external-service clients; safe API selection and blocked external effects remain required for all other mutations.

Arrivals never wait for previous requests. A late scheduler or exhausted `maxConcurrency` records a missed slot, with its planned timestamp and reason, and fails the run. Slots are not retried or shifted to make achieved throughput appear healthy. Every started request records epoch start/end, scheduling lateness, header latency, full-body duration, status and decoded body bytes; bodies are drained without parsing. Request failures and unexpected statuses fail the run. Requests already in flight at the end are drained within their configured timeout; these completions are reported separately from completions inside the offered-load window.

SSE connections are established before HTTP arrival scheduling begins. Their connection latency, consumed bytes/events, active counts and early closure are recorded. A failed connection, unexpected early termination, or drop below configured stream concurrency fails the run. Connections close intentionally at the duration boundary. No automatic reconnect conceals a loss of stream load. Data-event counts distinguish SSE `data:` frames from heartbeat comments. Gauges are written at measurement boundaries, stream changes and once per second.

Summaries include offered, started, successful and in-window completion rates per lane; missed/late/error counts; maximum request concurrency; maximum scheduler lateness; and requested/achieved stream concurrency. Raw records include `fixtureId`, population `profileSha256`, canonical workload-profile hash, condition, run ID and epoch timestamps for joining browser samples. A successful replay exits zero; missed arrivals, errors, broken streams or excessive end-of-window scheduler lateness exit nonzero. The population `qualified` field is not an assertion of workload equivalence or browser performance.

This tool reproduces configured HTTP arrival pressure, concurrent SSE connections, and the database work actually performed by selected safe writes. It does not reproduce model execution, sandbox CPU, Slack traffic, browser rendering, natural event fan-out without an event producer, or an empirical burst distribution. Constant-rate lanes are useful controlled envelopes; they must not be labeled an exact production trace. Browser tests measure rendering separately. A performance qualification must join their full measured interval to successful workload evidence, a measured input envelope and independent deployment/data parity evidence.

For real queued Pi turns, model-protocol timing, database writes and dynamic run-stream fanout, use the separately guarded [controlled producer](workload-producer.md). The ordinary CLI continues to reject turn dispatch. Its internal dispatcher hook is used only after that producer validates the running fixture identity and target database; it does not make generic HTTP replay equivalent to the production workload.
