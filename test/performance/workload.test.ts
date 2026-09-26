import assert from "node:assert/strict";
import test from "node:test";
import { runWorkload, validateWorkload, type WorkloadFixture, type WorkloadProfile } from "./workload.ts";

const fixture: WorkloadFixture = {
  schemaVersion: 1,
  fixtureId: "scheduler-test",
  databaseName: "qm_perf_scheduler_test",
  profileSha256: "synthetic-test-profile",
  qualified: false,
};

test("arrivals continue while responses wait, with SSE accounting and failure on lost offered load", async () => {
  const profile: WorkloadProfile = {
    schemaVersion: 1,
    baseUrl: "http://127.0.0.1:9999",
    fixtureId: fixture.fixtureId,
    isolated: true,
    externalEffectsDisabled: true,
    mode: "diagnostic",
    condition: "synthetic-scheduler-check",
    durationMs: 260,
    requestTimeoutMs: 2000,
    maxConcurrency: 10,
    maxStartDelayMs: 100,
    streamConnectTimeoutMs: 1000,
    requests: [{ name: "read", method: "GET", path: "/read", ratePerSecond: 20 }],
    streams: [{ name: "events", path: "/events", connections: 1 }],
  };
  assert.throws(() => validateWorkload({ ...profile, isolated: false } as unknown as WorkloadProfile, fixture));
  assert.throws(() => validateWorkload({ ...profile, baseUrl: "https://production.example.invalid" }, fixture, {}));
  assert.throws(() => validateWorkload({ ...profile, fixtureId: "different" }, fixture));
  assert.throws(() => validateWorkload({ ...profile, mode: "qualifying" }, fixture));
  for (const maxConcurrency of [10, 1]) {
    const held = Promise.withResolvers<void>();
    const measured = Promise.withResolvers<void>();
    const records: Record<string, unknown>[] = [];
    let requests = 0;
    const fetcher: typeof fetch = async (input, options) => {
      if (String(input).endsWith("/events")) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(': heartbeat\r\ndata: {"safe":true}\r\n\r\n'));
            options?.signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("Stopped", "AbortError")),
              { once: true },
            );
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      requests++;
      await held.promise;
      return new Response("body finished");
    };
    const running = runWorkload({ ...profile, maxConcurrency }, fixture, {
      fetcher,
      emit(record) {
        records.push(record);
        if (record.type === "measurement-end") measured.resolve();
      },
    });
    await measured.promise;
    const expected = Math.ceil((profile.durationMs * profile.requests[0]!.ratePerSecond) / 1000);
    assert.equal(requests, maxConcurrency === 1 ? 1 : expected, "response completion must not pace request arrivals");
    held.resolve();
    const summary = await running;
    assert.equal(summary.requests[0]!.offered, expected);
    assert.equal(summary.requests[0]!.completedInWindow, 0);
    assert.equal(summary.requests[0]!.started, requests);
    assert.equal(summary.requests[0]!.completed, requests);
    assert.equal(summary.requests[0]!.missed, expected - requests);
    assert.equal(summary.maxConcurrency, requests);
    assert.equal(summary.pass, maxConcurrency !== 1);
    assert.equal(summary.streams.expected, 1);
    assert.equal(summary.streams.minActive, 1);
    assert.equal(summary.streams.events, 1);
    assert.equal(summary.streams.errors, 0);
    assert.ok(summary.streams.bytes > 0);
    assert.equal(records.filter((record) => record.type === "request").length, requests);
    assert.equal(records.filter((record) => record.type === "missed").length, expected - requests);
    assert.ok(records.some((record) => record.type === "gauge" && record.activeStreams === 1));
    assert.ok(
      records
        .filter((record) => record.type === "request")
        .every((record) => typeof record.durationMs === "number" && record.durationMs > 0),
    );
  }
});

test("explicit native denial status remains visible and does not permit redirects or server errors", async () => {
  const profile: WorkloadProfile = {
    schemaVersion: 1,
    baseUrl: "http://127.0.0.1:9999",
    fixtureId: fixture.fixtureId,
    isolated: true,
    externalEffectsDisabled: true,
    mode: "diagnostic",
    condition: "native-denial",
    durationMs: 20,
    requestTimeoutMs: 1000,
    maxConcurrency: 2,
    maxStartDelayMs: 100,
    streamConnectTimeoutMs: 1000,
    streams: [],
    requests: [{ name: "denial", method: "GET", path: "/denied", ratePerSecond: 1, expectedStatuses: [403] }],
  };
  const records: Record<string, unknown>[] = [];
  const summary = await runWorkload(profile, fixture, {
    fetcher: async () => new Response(null, { status: 403 }),
    emit: (row) => records.push(row),
  });
  assert.equal(summary.pass, true);
  assert.equal(summary.requests[0]!.succeeded, 1);
  assert.equal(records.find((row) => row.type === "request")?.status, 403);
  for (const status of [302, 500])
    assert.throws(() =>
      validateWorkload({ ...profile, requests: [{ ...profile.requests[0]!, expectedStatuses: [status] }] }, fixture),
    );
});

test("recorded arrivals preserve quiet time and bursts independently of response completion", async () => {
  const offsets = [30, 30, 110, 170];
  const profile: WorkloadProfile = {
    schemaVersion: 1,
    baseUrl: "http://127.0.0.1:9999",
    fixtureId: fixture.fixtureId,
    isolated: true,
    externalEffectsDisabled: true,
    mode: "diagnostic",
    condition: "recorded-arrivals",
    durationMs: 210,
    requestTimeoutMs: 1000,
    maxConcurrency: 10,
    maxStartDelayMs: 100,
    streamConnectTimeoutMs: 1000,
    streams: [],
    requests: [{ name: "trace", method: "GET", path: "/read", ratePerSecond: 0, arrivalOffsetsMs: offsets }],
  };
  for (const bad of [[-1], [30, 20], [210], [Number.NaN], [1.5]])
    assert.throws(() =>
      validateWorkload({ ...profile, requests: [{ ...profile.requests[0]!, arrivalOffsetsMs: bad }] }, fixture),
    );
  assert.throws(() =>
    validateWorkload({ ...profile, requests: [{ ...profile.requests[0]!, ratePerSecond: 1 }] }, fixture),
  );
  const held = Promise.withResolvers<void>();
  const measured = Promise.withResolvers<void>();
  const records: Record<string, unknown>[] = [];
  let requests = 0;
  const running = runWorkload(profile, fixture, {
    fetcher: async () => {
      requests++;
      await held.promise;
      return new Response("done");
    },
    emit: (record) => {
      records.push(record);
      if (record.type === "measurement-end") measured.resolve();
    },
  });
  await measured.promise;
  assert.equal(requests, offsets.length);
  held.resolve();
  const summary = await running;
  assert.equal(summary.pass, true);
  assert.equal(summary.requests[0]!.targetRate, offsets.length / (profile.durationMs / 1000));
  assert.equal(summary.requests[0]!.offered, offsets.length);
  assert.equal(summary.requests[0]!.completedInWindow, 0);
  const calls = records.filter((record) => record.type === "request");
  assert.deepEqual(
    calls.map((record) => Number(record.scheduledAt) - summary.startedAt),
    offsets,
  );
  assert.ok(calls.every((record) => Number(record.startedAt) >= Number(record.scheduledAt)));
});

test("cancellation before start, during a quiet interval and with active requests retains a failed actual cutoff", async () => {
  for (const mode of ["before", "quiet", "active"] as const) {
    const abort = new AbortController();
    const records: Record<string, unknown>[] = [];
    let requests = 0;
    let closed = 0;
    if (mode === "before") abort.abort();
    const profile: WorkloadProfile = {
      schemaVersion: 1,
      baseUrl: "http://127.0.0.1:9999",
      fixtureId: fixture.fixtureId,
      isolated: true,
      externalEffectsDisabled: true,
      mode: "diagnostic",
      condition: "cancel-" + mode,
      durationMs: 10_000,
      requestTimeoutMs: 20_000,
      maxConcurrency: 2,
      maxStartDelayMs: 100,
      streamConnectTimeoutMs: 1000,
      requests: [
        {
          name: "read",
          method: "GET",
          path: "/read",
          ratePerSecond: 0,
          arrivalOffsetsMs: mode === "quiet" ? [5000] : [0, 5000],
        },
      ],
      streams: [{ name: "events", path: "/events", connections: 1 }],
    };
    const before = Date.now();
    const summary = await runWorkload(profile, fixture, {
      signal: abort.signal,
      emit(record) {
        records.push(record);
        if (record.type === "measurement-start" && mode === "quiet") setTimeout(() => abort.abort(), 20);
      },
      async fetcher(url, options) {
        assert.equal(options?.signal?.aborted, false);
        if (String(url).endsWith("/events"))
          return new Response(
            new ReadableStream({
              start(controller) {
                options!.signal!.addEventListener(
                  "abort",
                  () => {
                    closed++;
                    controller.error(new DOMException("Stopped", "AbortError"));
                  },
                  { once: true },
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        requests++;
        return new Promise((_resolve, reject) => {
          options!.signal!.addEventListener(
            "abort",
            () => {
              closed++;
              reject(new DOMException("Stopped", "AbortError"));
            },
            { once: true },
          );
          setTimeout(() => abort.abort(), 20);
        });
      },
    });
    assert.ok(Date.now() - before < 1000, "Cancellation waited for the planned interval or request timeout");
    assert.equal(summary.pass, false);
    assert.equal(summary.measurementComplete, false);
    assert.ok(summary.cancelledAt !== null);
    assert.ok(summary.finishedAt < summary.plannedFinishAt);
    assert.equal(summary.requests[0]!.offered, mode === "active" ? 1 : 0);
    assert.equal(summary.requests[0]!.started, requests);
    assert.equal(summary.requests[0]!.completed, requests);
    assert.equal(summary.requests[0]!.active, 0);
    assert.equal(summary.requests[0]!.errors, mode === "active" ? 1 : 0);
    assert.equal(closed, { active: 2, quiet: 1, before: 0 }[mode]);
    assert.equal(records.filter((record) => record.type === "measurement-start").length, mode === "before" ? 0 : 1);
    if (mode === "active") assert.equal(records.find((record) => record.type === "request")?.error, "cancelled");
  }
});
