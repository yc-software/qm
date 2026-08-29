import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createErrorLog } from "../src/admin/error-log.ts";
import { createMetricsSink } from "../src/admin/metrics-sink.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createTelemetry, type PersistedTelemetryInstance } from "../src/insights/telemetry.ts";
import { scopeId } from "../src/types.ts";

interface CapturedBatch {
  api_key: string;
  batch: { event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown> }[];
}

function fixture(
  opts: {
    enabled?: () => boolean;
    confirmEnabled?: () => Promise<boolean>;
    failStatuses?: number[];
    apiKey?: string | null;
    version?: string;
  } = {},
) {
  const calls: { url: string; body: CapturedBatch }[] = [];
  const failStatuses = [...(opts.failStatuses ?? [])];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const body = JSON.parse((init as { body: string }).body) as CapturedBatch;
    const failure = failStatuses.shift();
    if (failure !== undefined) return { ok: false, status: failure } as Response;
    calls.push({ url: String(url), body });
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;
  let now = 100 * 24 * 60 * 60_000;
  const telemetry = createTelemetry({
    ...(opts.apiKey === null ? {} : { apiKey: opts.apiKey ?? "phc_test" }),
    host: "https://ph.example",
    enabled: opts.enabled ?? (() => true),
    ...(opts.confirmEnabled ? { confirmEnabled: opts.confirmEnabled } : {}),
    instances: createMemoryMap<PersistedTelemetryInstance>(),
    ...(opts.version ? { version: opts.version } : {}),
    fetchImpl,
    now: () => now,
  });
  return { telemetry, calls, advance: (ms: number) => (now += ms) };
}

const events = (calls: { body: CapturedBatch }[]) => calls.flatMap((c) => c.body.batch);

test("telemetry: sends tracked events with a stable anonymous distinct_id and privacy flags", async () => {
  const { telemetry, calls } = fixture({ version: "abc123" });
  telemetry.track("skill_installed", { scope_kind: "personal" });
  await telemetry.flush();
  telemetry.track("cron_created", { scope_kind: "org" });
  await telemetry.flush();
  const sent = events(calls);
  assert.deepEqual(
    sent.map((e) => e.event).sort(),
    ["cron_created", "instance_heartbeat", "skill_installed"].sort(),
  );
  assert.equal(calls[0]!.url, "https://ph.example/batch/");
  assert.equal(calls[0]!.body.api_key, "phc_test");
  const ids = new Set(sent.map((e) => e.distinct_id));
  assert.equal(ids.size, 1);
  assert.match([...ids][0]!, /^[0-9a-f-]{36}$/);
  const skill = sent.find((e) => e.event === "skill_installed")!;
  assert.equal(skill.properties.version, "abc123");
  assert.equal(skill.properties.$lib, "qm");
  assert.equal(skill.properties.scope_kind, "personal");
  assert.equal(skill.properties.$geoip_disable, true);
  assert.equal(skill.properties.$process_person_profile, false);
});

test("telemetry: disabled means nothing is queued or sent", async () => {
  const { telemetry, calls } = fixture({ enabled: () => false });
  telemetry.track("skill_installed");
  await telemetry.flush();
  assert.equal(calls.length, 0);
});

test("telemetry: opting out mid-stream drops already-queued events", async () => {
  let on = true;
  const { telemetry, calls } = fixture({ enabled: () => on });
  telemetry.track("skill_installed");
  on = false;
  await telemetry.flush();
  on = true;
  await telemetry.flush();
  assert.ok(!events(calls).some((e) => e.event === "skill_installed"));
});

test("telemetry: the durable confirm check overrides a stale cached flag", async () => {
  const { telemetry, calls } = fixture({ enabled: () => false, confirmEnabled: async () => true });
  telemetry.track("dropped_before_confirm");
  await telemetry.flush();
  telemetry.track("cron_created");
  await telemetry.flush();
  const names = events(calls).map((e) => e.event);
  assert.ok(names.includes("cron_created"));
  assert.ok(!names.includes("dropped_before_confirm"));
});

test("telemetry: no api key means every hook is a no-op passthrough", async () => {
  const telemetry = createTelemetry({
    host: "https://ph.example",
    enabled: () => true,
    instances: createMemoryMap<PersistedTelemetryInstance>(),
  });
  const audit = createAuditLog();
  assert.equal(telemetry.tapAudit(audit), audit);
  telemetry.track("anything");
  await telemetry.flush();
  await telemetry.stop();
});

test("telemetry: audit tap forwards allowlisted actions with safe fields only", async () => {
  const { telemetry, calls } = fixture();
  const audit = telemetry.tapAudit(createAuditLog());
  const base = {
    at: 1,
    principalId: "U123SECRET",
    resource: "skill:secret-name",
    scopeLabel: scopeId("personal", "alice@example.com"),
  };
  audit.record({ ...base, action: "skill_create", status: "ok" });
  audit.record({ ...base, action: "memory.read" });
  audit.record({ ...base, action: "turn" });
  audit.record({ ...base, action: "security-posture.update" });
  audit.record({ ...base, action: "memory.self.update" });
  audit.record({ ...base, action: "conversation.update" });
  audit.record({ ...base, action: "constructor" });
  await telemetry.flush();
  const sent = events(calls).filter((e) => e.event !== "instance_heartbeat");
  assert.deepEqual(
    sent.map((e) => e.event),
    ["skill_installed", "config_updated"],
  );
  assert.equal(sent[0]!.properties.audit_action, "skill_create");
  assert.equal(sent[0]!.properties.scope_kind, "personal");
  assert.equal(sent[0]!.properties.status, "ok");
  assert.equal(sent[1]!.properties.section, "security-posture");
  const payload = JSON.stringify(sent);
  assert.ok(!payload.includes("U123SECRET"));
  assert.ok(!payload.includes("secret-name"));
  assert.ok(!payload.includes("alice@example.com"));
  assert.equal((await audit.events()).length, 7);
});

test("telemetry: metrics and error taps forward to the wrapped sink and track", async () => {
  const { telemetry, calls } = fixture();
  const metrics = telemetry.tapMetrics(createMetricsSink());
  const errors = telemetry.tapErrors(createErrorLog());
  metrics.record({ status: "ok", scopeLabel: scopeId("channel", "C1"), totalMs: 1234, toolCalls: 3 });
  metrics.record({ status: "capture", scopeLabel: scopeId("channel", "C1"), totalMs: 0 });
  errors.record({ category: "turn", code: "error", message: "boom secret", scopeLabel: scopeId("org", "acme") });
  await telemetry.flush();
  const sent = events(calls).filter((e) => e.event !== "instance_heartbeat");
  const turn = sent.find((e) => e.event === "turn_completed")!;
  assert.equal(turn.properties.duration_ms, 1234);
  assert.equal(turn.properties.tool_calls, 3);
  assert.equal(turn.properties.scope_kind, "channel");
  assert.ok(sent.some((e) => e.event === "memory_auto_captured"));
  const err = sent.find((e) => e.event === "error_recorded")!;
  assert.equal(err.properties.category, "turn");
  assert.ok(!JSON.stringify(sent).includes("boom secret"));
  assert.equal((await metrics.list()).length, 2);
  assert.equal(await errors.count(), 1);
});

test("telemetry: transient failures requeue with backoff and deliver after the delay", async () => {
  const { telemetry, calls, advance } = fixture({ failStatuses: [503] });
  telemetry.track("cron_created");
  await assert.rejects(() => telemetry.flush());
  assert.equal(calls.length, 0);
  await telemetry.flush();
  assert.equal(calls.length, 0);
  advance(61_000);
  await telemetry.flush();
  assert.ok(
    events(calls)
      .map((e) => e.event)
      .includes("cron_created"),
  );
});

test("telemetry: permanent rejections drop the batch instead of retrying forever", async () => {
  const { telemetry, calls, advance } = fixture({ failStatuses: [400] });
  telemetry.track("cron_created");
  await assert.rejects(() => telemetry.flush());
  advance(61_000);
  await telemetry.flush();
  assert.ok(
    !events(calls)
      .map((e) => e.event)
      .includes("cron_created"),
  );
});

test("telemetry: heartbeat fires daily per deployment and survives via the durable row", async () => {
  const { telemetry, calls, advance } = fixture();
  telemetry.track("cron_created");
  await telemetry.flush();
  advance(60_000);
  telemetry.track("cron_created");
  await telemetry.flush();
  advance(25 * 60 * 60_000);
  telemetry.track("cron_created");
  await telemetry.flush();
  const beats = events(calls).filter((e) => e.event === "instance_heartbeat");
  assert.equal(beats.length, 2);
});

test("telemetry: stop flushes the queue and swallows send failures", async () => {
  const { telemetry, calls } = fixture();
  telemetry.track("skill_installed");
  await telemetry.stop();
  assert.ok(events(calls).some((e) => e.event === "skill_installed"));
  const failing = fixture({ failStatuses: [503, 503, 503] });
  failing.telemetry.track("skill_installed");
  await failing.telemetry.stop();
  assert.equal(failing.calls.length, 0);
});
