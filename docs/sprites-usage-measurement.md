# Sprites usage measurement

This is a measurement design, not an implemented usage collector or a billing contract.
Provider sources were inspected on 2026-09-21. QM uses `@fly/sprites@0.2.3`.

Inventory, runtime, and storage need separate evidence. A sandbox record proves an
association, not continuous provider activity. A sleeping Sprite still exists, and guest
filesystem usage is not necessarily provider-billed storage. Reuse the existing
[sandbox resource model](./sandbox-resources.md) rather than creating a competing registry.

## Evidence and capabilities

The official API and SDK source establish the following capabilities. No authenticated
development-resource lifecycle test was performed for this document. In particular,
sleep/resume, identity continuity, storage semantics, and no-wake behavior remain
unverified against a live Sprite.

| Measurement        | Available evidence                                                               | Limitation                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Inventory          | Organization-scoped list/get, provider ID, name, creation/update times and state | Provider ID continuity across restart and replacement on same-name recreation need live verification.                           |
| Runtime state      | `running`, `warm`, `cold`, and optional last-running/last-warming timestamps     | Snapshots and last-state timestamps are not cumulative runtime.                                                                 |
| State stream       | SDK `watchSprites()` reads management NDJSON                                     | No replay cursor, durable event ID, resource incarnation ID or lossless-delivery guarantee was found in its published contract. |
| Exact running time | No suitable public cumulative counter or replayable history was found            | Initial running time must remain estimated with explicit gaps.                                                                  |
| Guest storage      | Filesystem entries expose file sizes; guest commands can inspect allocation      | File lengths, filesystem allocation and provisioned capacity are distinct.                                                      |
| Provider storage   | Hot/cold storage and checkpoint retention are documented concepts                | No per-resource billed-byte counter was found in the inspected public surface.                                                  |

Sources: [management API](https://sprites.dev/api/sprites),
[SDK client](https://github.com/superfly/sprites-js/blob/390eb6353576f5da57ef7ec4b7f1eec5223de5f3/src/client.ts),
[SDK types](https://github.com/superfly/sprites-js/blob/390eb6353576f5da57ef7ec4b7f1eec5223de5f3/src/types.ts),
and [public environment schema](https://sprites-binaries.t3.storage.dev/api/dev-latest/api_schema.json).
The schema was generated on 2026-09-15 and explicitly excludes internal socket-only APIs.
These findings do not establish that no private provider export exists.

## Inventory and resource identity

Use management `GET /v1/sprites` and `GET /v1/sprites/{name}`. Preserve the provider ID
within a trusted tenant/provider namespace and bind observations to a durable resource
incarnation. Names are locators; they must not join usage across deletion and recreation.
Keep provider creation time separate from local discovery time. Require durable ownership
or recoverable creation evidence before adopting a discovery; a prefix alone is insufficient.

List pagination uses `has_more` and `next_continuation_token`. The current management
reference permits 1–500 results, while the
[versioned reference](https://docs.sprites.dev/api/v001-rc48/sprites/) permits 1–50.
Request 50, follow opaque tokens, reject repeated/missing tokens, and record sweep
completeness. Returned state counts cover returned resources, not an independent complete
tenant inventory. Neither a failed page nor an absent name proves deletion. Confirm an
uncertain delete against the expected namespace and incarnation before closing its history.

SDK 0.2.3 maps snake_case responses and handles pagination with a page size of 50.
Its Date conversion retains millisecond precision; preserve raw provider timestamps when
finer source precision matters. Do not treat `updated_at` as last activity. The management
reference describes last-state fields as observations, while SDK comments describe
transitions. Retain those fields as hints until their actual update rules are verified.

## Runtime and passive collection

The [lifecycle documentation](https://docs.sprites.dev/concepts/lifecycle/) describes
automatic warm suspension after an idle window of about 30 seconds and a later cold state.
Warm resumes can preserve processes; cold resumes start processes fresh. Warm and cold
are sleeping states. Do not count warm time as running, use an assumed idle timeout as an
accounting event, or derive lifetime runtime from creation time.

The existing `computerStatus()` path in `src/sandbox/sprites-sandbox.ts` checks health,
reads checkpoint metadata, and executes guest `true`. It is unsuitable for periodic passive
measurement. `/check` is a health report; its `elapsed` field is not a documented lifetime
runtime counter, and its health status is not the management runtime-state enum.

Management list/get are candidates for passive observation, but an explicit no-wake
guarantee was not found. Test each on a sleeping development resource before enabling
periodic collection. Do not poll the Sprite application URL: it wakes the environment.
Treat guest filesystem, session, service and checkpoint reads as potentially waking or
activity-extending operations until individually verified. A future usage endpoint must
read persisted data without making provider calls.

`watchSprites()` sends `Accept: application/x-ndjson` to the management list endpoint.
Its event type includes name, state, optional timestamps and organization counts. Without
a verified replay and incarnation contract, it can supplement future observations but
cannot serve as an authoritative ledger. Re-resolve resource identity after reconnect or
recreation. A lost connection is missing evidence, not proof that the computer stopped.

### Proposed initial estimator

`estimatedRunningSeconds` is estimated wall-clock time in provider state `running`, counted
once per physical incarnation. It is separate from turn duration, CPU-seconds, memory
GB-seconds and billed usage. Keep confirmed runtime unavailable until a valid authoritative
source is established. Even exact wall-clock runtime would not reconstruct the provider's
separate CPU, memory and hot/cold storage meters.
[Official metering description](https://fly.io/sprites/).

The following values are initial collector policy, not provider guarantees:

1. Target one complete observation sweep every 60 seconds. Record request start/end,
   successful response time, source fields and sweep completeness. Use the request-window
   midpoint as the local observation time and retain its uncertainty window.
2. For consecutive successful known states of one incarnation at most 120 seconds apart,
   use 1 for `running` and 0 for `warm`/`cold`. Estimate interval runtime as its duration
   times the mean of the endpoint values. Differing states use a midpoint transition.
   Equal states assume continuity, but may still conceal unseen sleep/wake cycles.
3. Exclude intervals crossing failed/unknown observations, ambiguous incarnations or gaps
   longer than 120 seconds. Do not integrate before the first or after the last observation,
   or extrapolate a last-running state to now. Split reconstructed intervals at UTC month
   boundaries before totaling.
4. Report eligible sampled spans, uncovered time within the known existence window,
   collection start, sample count, largest gap, cadence and estimator version. Sampled
   coverage is not proof of continuous observation, and no strict error bound is claimed.
5. Observations older than 180 seconds are stale. Failed/incomplete inventory sweeps are
   explicit. Preserve last-known state separately from fresh current-state counts.

Existing persistent-computer inventory includes known resources not confirmed destroyed,
including warm/cold resources, with confirmation age and completeness. Currently running
counts require fresh successful `running` observations. Stale/unknown state belongs in an
unknown-current-state count. Separate scratch resources and historical cutoff inventory.

No numeric management request-rate limit was found. Resource concurrency limits are not
HTTP rate limits. Use bounded requests, non-overlapping coordinated sweeps, timeouts,
jitter and throttling backoff. Honor `Retry-After` when supplied and expose resulting gaps;
never translate authentication errors or throttling into an empty inventory.

## Storage measurement

Initial storage should be guest filesystem allocation sampled within already-required
active work. Record the covered filesystem/mount, source, byte units and sample time.
Inspect `/` and the actual sandbox root, deduplicating when they refer to the same
filesystem. Avoid recursive scans and do not sum directory entry sizes as physical usage.

Use filesystem statistics with explicit semantics:

- Used bytes: `(f_blocks - f_bfree) * f_frsize`.
- Capacity bytes: `f_blocks * f_frsize`.
- Available bytes: `f_bavail * f_frsize`.

Actual Sprite mounts and these statistics still need live verification. Guest-used bytes
do not resolve provider base-image sharing, compression, TRIM lag, cache allocation or
retained checkpoint blocks. Capacity is neither used nor billed storage.
[Storage lifecycle](https://docs.sprites.dev/concepts/lifecycle/),
[checkpoint storage](https://docs.sprites.dev/concepts/checkpoints/).

Piggyback a bounded sample at most every 15 minutes per incarnation. Do not start a guest
probe solely because an earlier status said running: the Sprite could sleep between the
check and the probe. Sampling may extend the required active execution; it must not initiate
an otherwise absent wake. A quiet resource can retain an old sample indefinitely.

Retain the last successful sample after failures; initially mark samples older than
24 hours stale. At a historical cutoff, use the latest sample at or before that cutoff.
Monthly storage reporting can include latest observed bytes and sampled peak, with sample
count, timestamps and coverage. A sampled peak is not a guaranteed true peak. Never sum
successive samples or per-resource peaks as a simultaneous tenant peak. Defer byte-seconds
until interpolation and stale-period coverage have a separate validated contract.

Leave provider-stored bytes, billed bytes and retained-checkpoint quantities unavailable.
Preserve historical samples after deletion and exclude destroyed incarnations from current
live-storage totals. Post-deletion retention and billing lag remain unverified.

## Time, attribution and durability

Use UTC calendar periods `[month start, next month start)`, not fixed-duration months.
Preserve raw timestamp precision, normalized microsecond timestamps and integer microsecond
durations; round only for display. Bytes are integers.

Count physical runtime once even when turns overlap or external/background work activates
the resource. Allocate runtime only through durable ownership valid for that interval.
Shared or uncertain ownership goes to a shared/unallocated bucket, not the full interval
for every participating thread or channel. Thread identity and computer identity remain
separate reporting dimensions.

Persist source facts, incarnation/ownership history and estimator version. Recompute
affected months atomically so late observations and corrections revise totals without
double counting. Keep unavailable, partial, stale and numeric zero separately expressible.
Estimated zero between sleeping observations is not proof of no intervening activity.

## Required live validation

Use only development resources created for the test and retain cleanup identities. Save
sanitized request windows, status codes and selected response fields, distinguishing raw
provider data from SDK conversions.

1. Create a private disposable Sprite and capture initial list/get identity and state.
   Exercise real continuation pagination, using a second disposable resource if necessary.
2. Run a short controlled command and record guest mount/allocation statistics during that
   activity. Close consoles, proxies, clients and keepalive tasks, then observe automatic
   warm/cold transitions without assuming a fixed sleep deadline.
3. Test list, get and watch separately while sleeping. Check that state remains sleeping
   and last-running time does not advance. Seek independent corroboration for short wakes
   that the tested sampler could miss; disclose that observability limit if unavailable.
4. Resume explicitly, verify a small persistent marker and compare resource ID/creation
   time. Restart and compare again. If a cold transition is not observed in a bounded test
   window, report warm-only evidence. A counter's restart survival requires an actual
   supported counter with known units/reset semantics; no such runtime counter was found.
5. Add and remove a small known amount of test data during required activity; compare
   filesystem allocation without calling it billed storage. Record checkpoint metadata
   separately from bytes and avoid treating sparse logical size as allocation.
6. Delete only test-created resources, confirm absence, recreate one exact name and compare
   identity, then delete the replacement. Preserve historical incarnation boundaries and
   record unresolved cleanup responses rather than claiming deletion succeeded.

Until these checks pass, passive-read behavior and identity/storage semantics remain
validation gates. The proposed measurements support operational analysis only. This
document does not add pricing, invoices, quotas, enforcement or a usage endpoint.
