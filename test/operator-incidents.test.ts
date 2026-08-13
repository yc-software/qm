import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createAdminService } from "../src/admin/admin-service.ts";
import { createErrorLog } from "../src/admin/error-log.ts";
import { listAdminIncidents } from "../src/api/routes/admin/observability.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createOperatorIncidentStore } from "../src/incidents/incident-store.ts";
import {
  createOperatorIncidentRuntime,
  explicitToolFailures,
  formatOperatorIncident,
  replyDeclaresInability,
  sanitizeIncidentText,
  type OperatorIncidentCursor,
} from "../src/incidents/operator-incidents.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createMemoryRunActivityStore } from "../src/runs/run-activity-store.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal } from "../src/types.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!ready(value) && Date.now() < deadline) {
    await sleep(10);
    value = await read();
  }
  assert.ok(ready(value), "condition became true before timeout");
  return value;
}

const actor: Principal = {
  id: "billy@chirocandy.com",
  type: "internal",
  displayName: "Billy Sticker",
};

function request(text: string): OrchestratorInput {
  return {
    actor,
    conversation: { kind: "dm", threadRef: "dm:U_BILLY", audience: [actor] },
    origin: { kind: "direct" },
    surface: "slack",
    text,
  };
}

test("incident text redacts credentials, query strings, and local paths", () => {
  const secret = "live-secret-value-123456";
  const raw =
    `Bearer ${secret} token=${secret} {"apiKey":"unknown-secret-value"} ` +
    `https://example.test/connect?code=${secret} ` +
    `C:\\Users\\ahmad\\private.txt /root/workspace/private.txt`;
  const clean = sanitizeIncidentText(raw, (text) => text.replaceAll(secret, "<redacted:TEST_SECRET>"));
  assert.doesNotMatch(clean, /live-secret|code=|Users\\ahmad|root\/workspace/);
  assert.doesNotMatch(clean, /unknown-secret-value/);
  assert.match(clean, /<redacted/);
  assert.match(clean, /<path>/);
});

test("declared inability detection catches blocked work without treating a healthy statement as failure", () => {
  assert.equal(replyDeclaresInability("I can't complete this task because the publisher is unavailable."), true);
  assert.equal(replyDeclaresInability("The task is blocked by a missing OAuth grant."), true);
  assert.equal(replyDeclaresInability("I can't see any problem with the completed report."), false);
  assert.equal(replyDeclaresInability("Completed. I can send the report after approval."), false);
});

test("tool failure extraction relies on explicit backend signals", () => {
  const failures = explicitToolFailures([
    {
      seq: 1,
      parentSeq: null,
      type: "tool_result",
      payload: { tool: "write", ok: false, error: "data required" },
      createdAt: 1,
    },
    {
      seq: 2,
      parentSeq: 1,
      type: "tool_result",
      payload: { tool: "read", ok: true, output: "no errors found" },
      createdAt: 2,
    },
    { seq: 3, parentSeq: 2, type: "text", payload: "publish failed", createdAt: 3 },
  ]);
  assert.deepEqual(failures, [{ tool: "write", message: "data required" }]);
});

test("runtime stores backend truth, routes one private Slack alert, and records delivery receipt", async () => {
  const errors = createErrorLog();
  const incidents = createOperatorIncidentStore();
  const deliveries = createDeliveryStore();
  const directory = createDirectoryStore();
  const sessions = createMemorySessionStore();
  const runActivity = createMemoryRunActivityStore();
  const { runs } = createMemoryRunStore();
  const cursors = createMemoryMap<OperatorIncidentCursor>();
  const secret = "private-api-key-123456";
  await directory.replace([
    {
      principalId: "ahmad@chirocandy.com",
      displayName: "Ahmad Bukhari",
      type: "internal",
      slackId: "U_AHMAD",
    },
  ]);
  const session = await sessions.getOrCreateByThread(
    "dm:U_BILLY",
    "dm",
    "personal:billy@chirocandy.com",
    undefined,
    "slack",
  );
  const runtime = createOperatorIncidentRuntime({
    incidents,
    errors,
    runs,
    runActivity,
    sessions,
    deliveries,
    directory,
    recipient: "ahmad@chirocandy.com",
    orgScopeId: "org:chirocandy",
    cursors,
    intervalMs: 5,
    maskSecrets: (text) => text.replaceAll(secret, "<redacted:TEST_SECRET>"),
  });
  runtime.start();
  try {
    const enqueued = await runs.enqueue({
      sessionId: session.threadRef,
      request: request(`Publish the report using token=${secret}`),
    });
    const claimed = await runs.claim("worker-1", 5_000);
    assert.equal(claimed?.id, enqueued.run.id);
    await runActivity.append(enqueued.run.id, {
      seq: 1,
      parentSeq: null,
      type: "tool_result",
      payload: { tool: "publish", ok: false, error: `builder failed at C:\\Users\\ahmad\\report using ${secret}` },
      createdAt: Date.now(),
    });
    errors.record({
      category: "publisher",
      code: "builder_unavailable",
      message: `remote builder returned 503 with ${secret}`,
      scopeLabel: session.scopeId,
      sessionId: session.id,
    });
    assert.equal(
      await runs.complete(enqueued.run.id, claimed!.leaseToken!, {
        status: "ok",
        reply: `I can't complete this task because the builder rejected ${secret}.`,
      }),
      true,
    );

    const rows = await eventually(
      () => incidents.list({ source: "run" }),
      (value) => value.length === 1,
    );
    const incident = rows[0]!;
    assert.equal(incident.discrepancy, false);
    assert.equal(incident.backendMessage, "remote builder returned 503 with <redacted:TEST_SECRET>");
    assert.equal(incident.toolFailureCount, 1);
    assert.equal(incident.backendErrorCount, 1);
    assert.ok((incident.durationMs ?? -1) >= 0);
    const coveredBackend = await eventually(
      () => incidents.list({ source: "backend" }),
      (value) => value.length === 1 && value[0]?.status === "acknowledged",
    );
    assert.equal(coveredBackend[0]?.notificationRequested, false);

    const pending = await eventually(
      () => deliveries.pending("principal"),
      (value) => value.length === 1,
    );
    const delivery = pending[0]!;
    assert.deepEqual(delivery.destination, {
      type: "principal",
      target: "U_AHMAD",
      audienceScopeId: "personal:ahmad@chirocandy.com",
    });
    assert.match(delivery.text, /Billy Sticker/);
    assert.match(delivery.text, /remote builder returned 503/);
    assert.match(delivery.text, /Execution:/);
    assert.doesNotMatch(delivery.text, /private-api-key|Users\\ahmad/);

    const deliveredAt = Date.now();
    await deliveries.ack(delivery.id, deliveredAt);
    const delivered = await eventually(
      () => incidents.get(incident.id),
      (value) => value?.notificationDeliveredAt === deliveredAt,
    );
    assert.equal(delivered?.notificationDeliveryId, delivery.id);
  } finally {
    runtime.stop();
  }
});

test("runtime correlates terminal runs stored by session id, matching the Postgres path", async () => {
  const incidents = createOperatorIncidentStore();
  const deliveries = createDeliveryStore();
  const directory = createDirectoryStore();
  await directory.replace([
    {
      principalId: "ahmad@chirocandy.com",
      displayName: "Ahmad Bukhari",
      type: "internal",
      slackId: "U_AHMAD",
    },
  ]);
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("dm:U_BILLY", "dm", "personal:billy@chirocandy.com");
  const { runs } = createMemoryRunStore();
  const runtime = createOperatorIncidentRuntime({
    incidents,
    errors: createErrorLog(),
    runs,
    runActivity: createMemoryRunActivityStore(),
    sessions,
    deliveries,
    directory,
    recipient: "ahmad@chirocandy.com",
    orgScopeId: "org:chirocandy",
    cursors: createMemoryMap<OperatorIncidentCursor>(),
    intervalMs: 5,
  });
  runtime.start();
  try {
    const enqueued = await runs.enqueue({ sessionId: session.id, request: request("Read the missing test file") });
    const claimed = await runs.claim("worker-1", 5_000);
    assert.equal(claimed?.id, enqueued.run.id);
    await runs.complete(enqueued.run.id, claimed!.leaseToken!, {
      status: "ok",
      reply: "I can't read the missing test file because no file tool is available.",
    });
    const rows = await eventually(
      () => incidents.list({ source: "run" }),
      (value) => value.length === 1,
    );
    assert.equal(rows[0]?.sessionId, session.id);
    assert.equal(rows[0]?.scopeLabel, session.scopeId);
    assert.equal(
      (
        await eventually(
          () => deliveries.pending("principal"),
          (value) => value.length === 1,
        )
      ).length,
      1,
    );
  } finally {
    runtime.stop();
  }
});

test("a session-bound backend error outside a run escalates after the grace window", async () => {
  const errors = createErrorLog();
  const incidents = createOperatorIncidentStore();
  const deliveries = createDeliveryStore();
  const directory = createDirectoryStore();
  await directory.replace([
    {
      principalId: "ahmad@chirocandy.com",
      displayName: "Ahmad Bukhari",
      type: "internal",
      slackId: "U_AHMAD",
    },
  ]);
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("dm:U_BILLY", "dm", "personal:billy@chirocandy.com");
  const { runs } = createMemoryRunStore();
  const runtime = createOperatorIncidentRuntime({
    incidents,
    errors,
    runs,
    runActivity: createMemoryRunActivityStore(),
    sessions,
    deliveries,
    directory,
    recipient: "ahmad@chirocandy.com",
    orgScopeId: "org:chirocandy",
    cursors: createMemoryMap<OperatorIncidentCursor>(),
    intervalMs: 5,
    backendEscalationGraceMs: 10,
  });
  runtime.start();
  try {
    errors.record({
      category: "connector",
      code: "background_sync_failed",
      message: "incremental sync returned 503",
      scopeLabel: session.scopeId,
      sessionId: session.id,
    });
    const pending = await eventually(
      () => deliveries.pending("principal"),
      (value) => value.length === 1,
    );
    assert.match(pending[0]!.text, /incremental sync returned 503/);
    const row = (await incidents.list({ source: "backend" }))[0]!;
    assert.equal(row.status, "open");
    assert.equal(row.notificationRequested, true);
  } finally {
    runtime.stop();
  }
});

test("clean success and expected approval do not create failure incidents", async () => {
  const errors = createErrorLog();
  const incidents = createOperatorIncidentStore();
  const deliveries = createDeliveryStore();
  const directory = createDirectoryStore();
  const sessions = createMemorySessionStore();
  const runActivity = createMemoryRunActivityStore();
  const { runs } = createMemoryRunStore();
  const session = await sessions.getOrCreateByThread("dm:U1", "dm", "personal:U1");
  const runtime = createOperatorIncidentRuntime({
    incidents,
    errors,
    runs,
    runActivity,
    sessions,
    deliveries,
    directory,
    recipient: "ahmad@chirocandy.com",
    orgScopeId: "org:chirocandy",
    cursors: createMemoryMap<OperatorIncidentCursor>(),
    intervalMs: 5,
  });
  runtime.start();
  try {
    for (const result of [
      { status: "ok" as const, reply: "Completed successfully." },
      { status: "pending_approval" as const, reply: "Approve the external send when ready." },
    ]) {
      const enqueued = await runs.enqueue({ sessionId: session.threadRef, request: request("Do the work") });
      const claimed = await runs.claim("worker-1", 5_000);
      await runs.complete(enqueued.run.id, claimed!.leaseToken!, result);
    }
    await sleep(30);
    assert.equal(await incidents.count(), 0);
    assert.equal((await deliveries.pending("principal")).length, 0);
  } finally {
    runtime.stop();
  }
});

test("admin incident logbook supports filters, counts, and stable cursor pagination", async () => {
  const incidents = createOperatorIncidentStore();
  const auditLog = createAuditLog();
  const deps = {
    admin: createAdminService(),
    auditLog,
    operatorIncidents: incidents,
  };
  for (const input of [
    { id: "incident-a", occurredAt: 300, severity: "critical" as const, source: "backend" as const },
    { id: "incident-b", occurredAt: 200, severity: "error" as const, source: "run" as const },
    { id: "incident-c", occurredAt: 100, severity: "warning" as const, source: "run" as const },
  ]) {
    await incidents.record({
      ...input,
      idempotencyKey: input.id,
      status: "open",
      category: "test",
      code: "synthetic",
      intentional: false,
      discrepancy: false,
      scopeLabel: "org:default-org",
      backendMessage: "redacted diagnostic",
      notificationRequested: false,
    });
  }
  const invoke = async (path: string): Promise<{ status: number; body: any }> => {
    let status = 0;
    let body: any;
    const req = { headers: { "x-admin-actor": "admin-alice@default-org" } } as unknown as IncomingMessage;
    const res = {
      writeHead(nextStatus: number) {
        status = nextStatus;
        return this;
      },
      end(data: string) {
        body = JSON.parse(data);
        return this;
      },
    } as unknown as ServerResponse;
    const url = new URL(path, "http://core.test");
    await listAdminIncidents({ req, res, deps, url, capability: null } as unknown as ApiCtx);
    return { status, body };
  };

  const first = await invoke("/v1/admin/incidents?scope=org:default-org&limit=2");
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.body.incidents.map((row: { id: string }) => row.id),
    ["incident-a", "incident-b"],
  );
  assert.ok(first.body.nextCursor);

  const second = await invoke(
    `/v1/admin/incidents?scope=org:default-org&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
  );
  assert.deepEqual(
    second.body.incidents.map((row: { id: string }) => row.id),
    ["incident-c"],
  );

  const critical = await invoke("/v1/admin/incidents?scope=org:default-org&severity=critical");
  assert.deepEqual(
    critical.body.incidents.map((row: { id: string }) => row.id),
    ["incident-a"],
  );

  const count = await invoke("/v1/admin/incidents?scope=org:default-org&source=run&count=1");
  assert.equal(count.body.total, 2);
  assert.ok((await auditLog.events()).some((event) => event.action === "incidents.read"));
});

test("Slack alert renders backend truth without a fake execution line for background-only incidents", async () => {
  const store = createOperatorIncidentStore(() => 400);
  const incident = await store.record({
    id: "background-incident",
    idempotencyKey: "background-incident",
    source: "backend",
    severity: "critical",
    status: "open",
    category: "database",
    code: "connection_failed",
    intentional: false,
    discrepancy: false,
    occurredAt: 300,
    scopeLabel: "org:chirocandy",
    backendMessage: "database connection timed out",
    notificationRequested: true,
  });
  const text = formatOperatorIncident(incident);
  assert.match(text, /rotating_light/);
  assert.match(text, /System process/);
  assert.match(text, /database connection timed out/);
  assert.doesNotMatch(text, /Execution:/);
});
