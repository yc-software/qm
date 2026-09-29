# Sprites protocol fixture

`workload-sprites.ts` serves the real Sprites REST and binary WebSocket protocol outside QM. Point an isolated instance's existing `SPRITES_BASE_URL` and synthetic `SPRITES_TOKEN` at this process. QM's adapter, installed SDK, credential processing and persistence remain unchanged.

Each synthetic sprite is a new container from an explicitly pinned, already available Linux sandbox image. Containers have networking disabled, no mounts, bounded CPU/memory/PIDs and a unique campaign label. The responder invokes Docker with argument arrays; it never executes request text in a host shell. It refuses existing containers and checks image, labels, network and mounts before operations or removal.

The JSON profile follows `SpritesFixtureProfile`. It binds the fixture identity, new campaign UUID, synthetic token environment variable, namespace, image ID, concurrency/byte/time limits, response chunk size and explicit delays. `scripts` contains named SHA-256 admissions produced by `spritesScriptSha256` from reviewed native scripts. That function normalizes UUIDs, native turn-directory identifiers and specific ephemeral token assignments. It preserves command text. Unknown scripts, extra command text, unsupported methods/options and paths outside `/home/sprite/` fail closed. Never automatically admit an observed rejected script.

```sh
node test/performance/workload-sprites.ts \
  --profile /private/sprites-profile.json \
  --fixture /private/fixture.json \
  --out /private/new-sprites-receipts.jsonl
```

The token must begin with `qm-perf-` and is read only from the configured environment variable. Loopback is the default boundary; a remote bind requires `QM_PERFORMANCE_BIND_HOST` to match the profile exactly. The output file is created exclusively with mode0600. Authenticated `/__qm_performance` exposes profile/population identity and counters, never the token. A profile can configure at most64 guests; its actual `maxSprites` remains the enforced limit. That ceiling is not a capacity claim.

HTTP and exec receipts retain absolute `startedAt`/`finishedAt` alongside the existing monotonic duration and emission `at`. HTTP records contain a bounded method, validated fixture guest name, hashes of the admitted request target, ordered file paths and request body, and the response body hash. Unadmitted or unavailable values are null/empty. Paths, bodies and credentials are not logged in plaintext. HTTP timing includes request reading and response completion; exec timing begins after complete stdin and includes the existing operation/failure-cleanup boundary. These clocks do not establish a cross-host offset bound.

Exec `outer` records the observed process exit, stdout/stderr byte lengths and hashes, or null if no complete process result exists. `nativeEnvelope` records strictly parsed native inner exit/stdout/stderr lengths and hashes only when the complete six-field envelope is valid; unsupported or corrupt envelopes are null. Parsing never changes transport behavior. `pass` still means the responder completed sending its outer transport result: a valid native inner exit7 can have `pass:true`. Outer wire/frame bytes, inner logical bytes and delivery completion remain separate observations.

Supported calls cover create/get/delete, policy write/readback, file write/rename/read, native exec and checkpoint protocol receipts. Checkpoints are explicitly protocol metadata: disk snapshots, restore, restart, process sessions and real Sprites network enforcement are not established by this fixture. All results remain `qualified:false`; injected delays are assumptions until calibrated with independently captured provider evidence. Docker guest performance is not Sprites microVM parity.

SIGTERM/SIGINT stop admission, close WebSockets, drain bounded work and remove owned guests. A receipt-write failure stops new admission and makes shutdown fail after attempting every owned guest's cleanup. Ambiguous creation or failed cleanup produces a failure and retained intent, never a claim of complete cleanup. A killed process can leave labelled guests; inspect the retained campaign evidence before removing only those owned resources. Never prune unrelated Docker state.

Run the focused check with an immutable local image ID:

```sh
QM_PERFORMANCE_SPRITES_IMAGE=sha256:... \
  node --test test/performance/workload-sprites.test.ts
```

The integration test uses the unchanged native adapter and SDK over real loopback HTTP/WS, checks cold/warm provisioning, file bytes and explicit file modes, overlaps execution in two guests, rejects unauthorized/unreviewed traffic, and checks pending-work shutdown and cleanup even when receipt writes fail. Native script reference capture runs in a separate test-only process; the network test's fetch and WebSocket globals are unchanged. Without the explicit image variable, the Docker integration check is skipped and provides no readiness evidence.
