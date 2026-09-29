import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { Context, Model } from "@earendil-works/pi-ai";
import {
  createWorkloadProvider,
  parseProviderTurn,
  syntheticText,
  turnMarker,
  validateProvider,
  type ProviderProfile,
} from "./workload-provider.ts";
import {
  consumeRunStream,
  PRODUCER_TABLES,
  validateProducer,
  writeRates,
  reserveHistorySession,
  scheduledCronTime,
  verifyReadBytes,
  PRODUCER_QUALIFICATION_GAPS,
  type ProducerLane,
  type ProducerProfile,
} from "./workload-producer.ts";
import { runWorkload, validateWorkload, type WorkloadFixture, type WorkloadProfile } from "./workload.ts";

const fixture: WorkloadFixture = {
  schemaVersion: 1,
  fixtureId: "provider-test",
  databaseName: "qm_perf_provider_test",
  profileSha256: "fixture-hash",
  qualified: false,
  principals: [{ principalId: "perf@example.invalid" }],
};
const env = {
  TOKEN: "qm-perf-unit-test-token-only",
  DATABASE: "postgres://unused@localhost/qm_perf_provider_test",
  SECRET: "fixture-source-secret",
  PORTAL: "fixture-portal-identity-secret",
  QM_PERFORMANCE_PRODUCER_ORIGIN: "http://localhost:9999",
};
const provider: ProviderProfile = {
  schemaVersion: 1,
  fixtureId: fixture.fixtureId,
  model: "qm-perf-model",
  tokenEnv: "TOKEN",
  host: "127.0.0.1",
  port: 0,
  shapes: [
    {
      name: "two",
      modelCalls: 2,
      inputBytes: 300,
      outputBytes: 127,
      delayMs: 4,
      chunkBytes: 31,
      chunkIntervalMs: 2,
      repeatedFraction: 0.3,
      readPath: "shared/read.txt",
    },
  ],
};

test("provider validates the bounded model-call range", () => {
  const profile = structuredClone(provider);
  for (const modelCalls of [1, 101, 500, 1000]) {
    profile.shapes[0]!.modelCalls = modelCalls;
    assert.equal(validateProvider(profile, fixture, env), env.TOKEN);
  }
  profile.shapes[0]!.modelCalls = 1001;
  assert.throws(() => validateProvider(profile, fixture, env), /safety bound/);
});

test("provider twin exercises the installed Anthropic protocol client through a timed read-tool loop", async () => {
  const records: Record<string, unknown>[] = [];
  const twin = createWorkloadProvider(provider, fixture, (record) => records.push(record), env);
  await new Promise<void>((resolve) => twin.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(twin.server.address() as AddressInfo).port}`;
  const model: Model<"anthropic-messages"> = {
    id: provider.model,
    name: provider.model,
    api: "anthropic-messages",
    provider: "perf",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 2000,
  };
  const context: Context = {
    messages: [{ role: "user", content: turnMarker(fixture.fixtureId, "two", "first"), timestamp: Date.now() }],
    tools: [
      {
        name: "files",
        description: "Read the fixture file",
        parameters: Type.Object({ action: Type.Literal("read"), path: Type.String() }),
      },
    ],
  };
  try {
    const first = await stream(model, context, { apiKey: env.TOKEN }).result();
    assert.equal(first.stopReason, "toolUse", first.errorMessage);
    const tool = first.content.find((item) => item.type === "toolCall");
    assert.ok(tool && tool.type === "toolCall");
    assert.equal(tool.name, "files");
    assert.deepEqual(tool.arguments, { action: "read", path: "shared/read.txt" });
    context.messages.push(first, {
      role: "toolResult",
      toolCallId: tool.id,
      toolName: "files",
      content: [{ type: "text", text: syntheticText("file", 4096, 0.4) }],
      isError: false,
      timestamp: Date.now(),
    });
    const final = await stream(model, context, { apiKey: env.TOKEN }).result();
    assert.equal(final.stopReason, "stop", final.errorMessage);
    assert.equal(
      final.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("").length,
      127,
    );
    assert.equal(twin.totals.calls, 2);
    assert.equal(twin.totals.errors, 0);
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((item) => item.step),
      [0, 1],
    );
    assert.ok(
      records.every(
        (item) =>
          Number(item.finishedAt) > Number(item.firstDeltaAt) &&
          Number(item.requestGzipBytes) > 0 &&
          Number(item.chunks) === 5,
      ),
    );
    const denied = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": env.TOKEN },
      body: JSON.stringify({
        model: provider.model,
        stream: true,
        messages: [{ role: "user", content: "unmarked request" }],
      }),
    });
    assert.equal(denied.status, 400);
    assert.equal(twin.totals.errors, 1);
    assert.ok(!JSON.stringify(records).includes(env.TOKEN));
  } finally {
    twin.server.closeAllConnections();
    await new Promise<void>((resolve) => twin.server.close(() => resolve()));
  }
});

test("producer rejects unsafe targets, unqualified mode, missing real file bytes and generic turn replay", () => {
  const bounds = { min: 0, max: 100 };
  const profile: ProducerProfile = {
    workload: {
      schemaVersion: 1,
      fixtureId: fixture.fixtureId,
      isolated: true,
      externalEffectsDisabled: true,
      mode: "diagnostic",
      condition: "controlled",
      baseUrl: "http://localhost:9999",
      durationMs: 1000,
      requestTimeoutMs: 2000,
      maxConcurrency: 10,
      maxStartDelayMs: 100,
      streamConnectTimeoutMs: 1000,
      requests: [],
      streams: [],
    },
    databaseUrlEnv: "DATABASE",
    sourceSecretEnv: "SECRET",
    portalIdentitySecretEnv: "PORTAL",
    providerUrl: "http://localhost:9998",
    warmupMs: 0,
    guardCase: { sessionId: "fixture", principalId: "perf@example.invalid", expectedVisibleText: "fixture" },
    lanes: [
      {
        name: "turn",
        shape: "two",
        ratePerSecond: 1,
        principalId: "perf@example.invalid",
        origin: "direct",
        subscribers: 2,
      },
    ],
    evidence: {
      kind: "controlled-envelope",
      sourceSha256: ["measured-profile"],
      limitations: ["unmodeled scheduling"],
    },
    bounds: { running: bounds, writes: {}, runEventsPerSecond: bounds, runBytesPerSecond: bounds },
  };
  assert.throws(() => validateProducer(profile, fixture, provider, env), /real, hashed fixture read file/);
  const populated = {
    ...fixture,
    workload: {
      readFiles: [
        {
          principalId: "perf@example.invalid",
          path: "shared/read.txt",
          artifactId: "1".repeat(32),
          scopeId: "personal:perf@example.invalid",
          contentBytes: 4096,
          contentSha256: "a".repeat(64),
        },
      ],
    },
  };
  assert.doesNotThrow(() => validateProducer(profile, populated, provider, env));
  const trace = { ...profile.lanes[0]!, ratePerSecond: 0, arrivals: { warmup: [30], measured: [50, 50, 700] } };
  assert.doesNotThrow(() => validateProducer({ ...profile, warmupMs: 100, lanes: [trace] }, populated, provider, env));
  assert.throws(() => validateProducer({ ...profile, lanes: [trace] }, populated, provider, env), /warmup window/);
  assert.throws(
    () => validateProducer({ ...profile, warmupMs: 30, lanes: [trace] }, populated, provider, env),
    /inside the measurement window/,
  );
  const cron = { ...profile.lanes[0]!, origin: "cron" as const, cron: { scheduleLeadMs: 1000, maxFireDelayMs: 5000 } };
  assert.doesNotThrow(() => validateProducer({ ...profile, lanes: [cron] }, populated, provider, env));
  assert.throws(
    () => validateProducer({ ...profile, lanes: [{ ...cron, cron: undefined }] }, populated, provider, env),
    /future schedule lead/,
  );
  assert.throws(
    () => validateProducer({ ...profile, portalIdentitySecretEnv: undefined }, populated, provider, env),
    /portal identity signer/,
  );
  assert.throws(
    () =>
      validateProducer(
        {
          ...profile,
          lanes: [
            {
              ...profile.lanes[0]!,
              history: { name: "missing", entries: { min: 1, max: 9 }, tapeBytes: { min: 1, max: 9999 }, sessions: [] },
            },
          ],
        },
        populated,
        provider,
        env,
      ),
    /History cohort is empty/,
  );
  assert.throws(
    () =>
      validateProducer(profile, populated, provider, {
        ...env,
        QM_PERFORMANCE_PRODUCER_ORIGIN: "https://production.invalid",
      }),
    /isolated core origin/,
  );
  assert.throws(
    () =>
      validateProducer({ ...profile, workload: { ...profile.workload, mode: "qualifying" } }, populated, provider, env),
    /blocks qualification/,
  );
  assert.throws(() => validateProvider(provider, fixture, { TOKEN: "real-provider-secret" }), /synthetic/);
  assert.throws(
    () =>
      parseProviderTurn(
        {
          model: provider.model,
          stream: true,
          messages: [{ role: "user", content: turnMarker(fixture.fixtureId, "two", "unreadable") }],
          tools: [{ name: "files", input_schema: { properties: { action: { const: "write" } } } }],
        },
        provider,
      ),
    /Real read tool unavailable/,
  );
  assert.throws(
    () =>
      parseProviderTurn(
        { model: provider.model, stream: true, messages: [{ role: "user", content: "[qm-perf:wrong:two:first]" }] },
        provider,
      ),
    /mismatch/,
  );
  assert.throws(
    () =>
      validateWorkload(
        {
          ...profile.workload,
          requests: [{ name: "unsafe", method: "POST", path: "/v1/turns?async=1", ratePerSecond: 1 }],
        },
        fixture,
      ),
    /does not dispatch/,
  );
  const before = PRODUCER_TABLES.map((relname) => ({
    relname,
    n_tup_ins: "5",
    n_tup_upd: "2",
    n_tup_del: "1",
    stats_reset: "unchanged",
  }));
  assert.equal(
    writeRates(
      before,
      before.map((row) => ({ ...row, n_tup_ins: "9" })),
      2,
    )[0]!.inserts,
    2,
  );
  assert.throws(
    () =>
      writeRates(
        before,
        before.map((row) => ({ ...row, n_tup_ins: "0" })),
        2,
      ),
    /decreased/,
  );
  assert.throws(
    () =>
      writeRates(
        before,
        before.map((row) => ({ ...row, stats_reset: "changed" })),
        2,
      ),
    /reset/,
  );
});

test("history arrivals fail visibly when their selected session is busy instead of opening fresh threads", async () => {
  const lane: ProducerLane = {
    name: "history",
    shape: "two",
    origin: "direct",
    ratePerSecond: 20,
    principalId: "perf@example.invalid",
    subscribers: 1,
    history: {
      name: "measured",
      entries: { min: 2, max: 20 },
      tapeBytes: { min: 100, max: 10000 },
      sessions: [{ sessionId: "seeded", threadRef: "web:perf@example.invalid:seeded", expectedVisibleText: "seeded" }],
    },
  };
  const workload: WorkloadProfile = {
    schemaVersion: 1,
    baseUrl: "http://127.0.0.1:9999",
    fixtureId: fixture.fixtureId,
    isolated: true,
    externalEffectsDisabled: true,
    mode: "diagnostic",
    condition: "busy-history",
    durationMs: 180,
    requestTimeoutMs: 2000,
    maxConcurrency: 20,
    maxStartDelayMs: 500,
    streamConnectTimeoutMs: 1000,
    requests: [{ name: lane.name, method: "POST", path: "/v1/turns?async=1", ratePerSecond: lane.ratePerSecond }],
    streams: [],
  };
  const busy = new Set<string>(),
    held = Promise.withResolvers<void>(),
    ended = Promise.withResolvers<void>();
  let ordinal = 0,
    dispatched = 0;
  const running = runWorkload(workload, fixture, {
    emit(record) {
      if (record.type === "measurement-end") ended.resolve();
    },
    dispatchTurn: async () => {
      const selected = reserveHistorySession(lane, ordinal++, busy)!;
      dispatched++;
      try {
        await held.promise;
        return new Response("done");
      } finally {
        busy.delete(selected.threadRef);
      }
    },
  });
  await ended.promise;
  held.resolve();
  const summary = await running;
  const offered = Math.ceil((workload.durationMs * lane.ratePerSecond) / 1000);
  assert.equal(dispatched, 1);
  assert.equal(summary.requests[0]!.offered, offered);
  assert.equal(summary.requests[0]!.succeeded, 1);
  assert.equal(summary.requests[0]!.errors, offered - 1);
  assert.equal(summary.pass, false);
  assert.equal(busy.size, 0);
  assert.equal(reserveHistorySession(lane, ordinal, busy)!.sessionId, "seeded");
});

test("native cron slots remain absolute and actual file bytes must match the durable evidence", async () => {
  const lane: ProducerLane = {
    name: "scheduled",
    shape: "two",
    origin: "cron",
    ratePerSecond: 2,
    principalId: "perf@example.invalid",
    subscribers: 1,
    cron: { scheduleLeadMs: 3000, maxFireDelayMs: 1000 },
  };
  assert.equal(scheduledCronTime(lane, 1000, 2, 2000), 5000);
  assert.equal(scheduledCronTime(lane, 1000, 2, 4999), 5000);
  assert.throws(() => scheduledCronTime(lane, 1000, 2, 5000), /refusing to shift/);
  const trace = { ...lane, ratePerSecond: 0, arrivals: { warmup: [200], measured: [100, 100, 900] } };
  assert.equal(scheduledCronTime(trace, 1000, 0, 2000, "warmup"), 4200);
  assert.equal(scheduledCronTime(trace, 1000, 2, 2000), 4900);
  assert.throws(() => scheduledCronTime(trace, 1000, 3, 2000), /refusing to shift/);
  const bytes = Buffer.from("actual durable fixture bytes");
  const expected = { contentBytes: bytes.length, contentSha256: createHash("sha256").update(bytes).digest("hex") };
  assert.deepEqual(await verifyReadBytes(new Response(bytes), expected), {
    bytes: bytes.length,
    sha256: expected.contentSha256,
  });
  await assert.rejects(verifyReadBytes(new Response(Buffer.alloc(bytes.length)), expected), /hash mismatch/);
  await assert.rejects(verifyReadBytes(new Response(bytes.subarray(1)), expected), /hash mismatch/);
  await assert.rejects(verifyReadBytes(new Response(Buffer.concat([bytes, bytes])), expected), /exceeds/);
  await assert.rejects(verifyReadBytes(new Response(null, { status: 404 }), expected), /unavailable/);
  assert.ok(PRODUCER_QUALIFICATION_GAPS.includes("slack-ingress-and-delivery"));
  assert.ok(PRODUCER_QUALIFICATION_GAPS.includes("auxiliary-model-traffic"));
});

test("dynamic run streams require matching identity, a real terminal snapshot, and successful tools", async () => {
  const runId = "fixture-run";
  const events = [
    { type: "RUN_STARTED", runId },
    { type: "CUSTOM", name: "run", value: { status: "done", result: { status: "replied" } } },
    { type: "RUN_FINISHED", runId },
  ];
  const response = (items: unknown[]) =>
    new Response(items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  let frames = 0;
  await consumeRunStream(response(events), runId, new AbortController().signal, () => {
    frames++;
  });
  assert.equal(frames, 3);
  await assert.rejects(
    consumeRunStream(response(events.slice(0, 2)), runId, new AbortController().signal, () => {}),
    /successfully/,
  );
  await assert.rejects(
    consumeRunStream(response(events), "wrong-run", new AbortController().signal, () => {}),
    /identity/,
  );
  await assert.rejects(
    consumeRunStream(
      response([events[0], { type: "TOOL_CALL_RESULT", isError: true }, ...events.slice(1)]),
      runId,
      new AbortController().signal,
      () => {},
    ),
    /successfully/,
  );
});
