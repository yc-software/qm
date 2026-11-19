import { webhookRoutes } from "../src/api/routes/webhooks.ts";
import { createMonitorBroker } from "../src/monitors/monitor-broker.ts";
import { createPostgresProcessRegistry } from "../src/processes/process-registry.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { loopRoutes } from "../src/api/routes/loops.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import { settle } from "./support/settle.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { testMap } from "./support/test-database.ts";
import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createControlService } from "../src/api/control-service.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { runNowSettled } from "./support/settle.ts";
import { runTrigger } from "../src/triggers/run-trigger.ts";
import { principalDestination } from "../src/reach/reach.ts";
import type { CapabilityClaims } from "../src/auth/capability-token.ts";
import { testTenant } from "./support/test-tenant.ts";

const ownerScope = "personal:U1";
const provenance = {
  sensitivity: "restricted" as const,
  sources: ["group:restricted", "personal:U1"],
  sourceUnknown: true,
};

async function fixture() {
  const built = buildApp(testConfig());
  await built.app.upsertDirectory([
    { principalId: "U1", displayName: "Alice", type: "internal" },
    { principalId: "U2", displayName: "Bob", type: "internal" },
  ]);
  const session = await built.sessions.getOrCreateByThread("private-trigger-origin", "dm", ownerScope);
  const context = (): CapabilityClaims => ({
    privateRead: true,
    actorId: "U1",
    scopeId: ownerScope,
    sessionId: session.id,
    threadRef: session.threadRef,
    destination: principalDestination("U1", "U1"),
    exp: Date.now() + 60_000,
  });
  const protect = () =>
    built.sessions.recordContextProvenance(session.id, ownerScope, { ...provenance, personalOnly: true });
  return { built, session, context, protect, control: createControlService(built.app, built.scheduler) };
}

test("a late private context creates a distinct personal schedule and refuses a different recipient", async () => {
  const f = await fixture();
  const stale = f.context();
  const request = { schedule: { everyMs: 3_600_000 }, text: "Personal scheduled output" };
  const ordinary = await f.control.createCron(request, stale);
  assert.ok(ordinary.ok);
  await f.protect();
  const result = await f.control.createCron(request, stale);
  assert.ok(result.ok, JSON.stringify(result));
  assert.notEqual(result.cron.id, ordinary.cron.id);
  const saved = (await f.built.crons.get(result.cron.id))!;
  assert.equal(saved.personalOnly, true);
  assert.deepEqual(saved.sourceProvenance, provenance);
  assert.deepEqual(saved.destination, principalDestination("U1", "U1"));
  const other = await f.built.sessions.getOrCreateByThread("private-trigger-same-authority", "dm", ownerScope);
  await f.built.sessions.recordContextProvenance(other.id, ownerScope, {
    ...provenance,
    sources: provenance.sources.toReversed(),
    personalOnly: true,
  });
  const repeated = await f.control.createCron(request, {
    ...f.context(),
    sessionId: other.id,
    threadRef: other.threadRef,
  });
  assert.ok(repeated.ok);
  assert.equal(repeated.cron.id, saved.id);
  const foreign = await f.control.createCron({ ...request, recipient: "Bob" }, f.context());
  assert.equal(foreign.ok, false);
  assert.equal((await f.built.crons.list()).length, 2);
  const shared = await f.built.sessions.getOrCreateByThread("trigger-shared-reader", "channel", "channel:C9");
  const reader = { ...f.context(), scopeId: shared.scopeId, sessionId: shared.id };
  assert.equal(
    (await f.control.listCrons(reader)).crons.some((cron) => cron.id === saved.id),
    false,
  );
  assert.equal((await f.control.getCron(saved.id, reader)).ok, false);
  assert.equal((await f.built.sessions.get(shared.id))!.personalOnly, undefined);
});

test("scheduled execution stores privacy and restricted provenance before the model runs", async () => {
  let observedSession = "";
  let cronId = "";
  const agent = createMockAgent();
  const built = buildApp(testConfig(), {
    agent: {
      ...agent,
      runTurn: async (input) => {
        observedSession = input.session.id;
        assert.equal(input.session.personalOnly, true);
        assert.equal((await built.sessions.get(input.session.id))!.personalOnly, true);
        assert.equal(input.session.sourceProvenance?.sensitivity, "restricted");
        assert.ok(input.session.sourceProvenance?.sources.includes("group:restricted"));
        await built.app.setCronFireNote(
          testTenant,
          cronId,
          { text: "Next private fire", at: Date.now() },
          { privateRead: true, actorId: "U1", scopeId: ownerScope, sessionId: input.session.id },
        );
        await input.emit({ kind: "AgentMessage", text: "Private scheduled reply" });
        return { reply: "Private scheduled reply", modelCalls: 0 };
      },
    },
  });
  await built.app.upsertDirectory([{ principalId: "U1", displayName: "Alice", type: "internal" }]);
  const session = await built.sessions.getOrCreateByThread("private-scheduled-owner", "dm", ownerScope);
  await built.sessions.recordContextProvenance(session.id, ownerScope, { ...provenance, personalOnly: true });
  const cron = await built.app.createCron({
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: ownerScope,
    schedule: { everyMs: 3_600_000 },
    action: "Make a personal report",
    context: { privateRead: true, actorId: "U1", scopeId: ownerScope, sessionId: session.id },
    destination: principalDestination("U1", "U1"),
  });
  cronId = cron.id;
  built.runtime.start();
  await runNowSettled(built.scheduler, cron.id);
  assert.ok(observedSession);
  assert.equal((await built.crons.get(cron.id))!.lastFireNote?.text, "Next private fire");
  assert.equal((await built.sessions.get(observedSession))!.personalOnly, true);
  assert.equal((await built.deliveries.pending("principal"))[0]?.provenance?.contextProvenance?.personalOnly, true);
  assert.deepEqual(
    (await built.deliveries.pending("principal")).map((delivery) => [delivery.destination.target, delivery.text]),
    [["U1", "Private scheduled reply"]],
  );
});

test("private fire validation blocks decorated delivery before exact-text enqueue or model execution", async () => {
  const f = await fixture();
  let runs = 0;
  const outcome = await runTrigger(
    {
      deliveries: f.built.deliveries,
      idempotency: createIdempotencyStore(testMap()),
      identity: f.built.identity,
      run: async () => {
        runs++;
        return { status: "ok" };
      },
    },
    {
      owner: "U1",
      ownerScopeId: ownerScope,
      personalOnly: true,
      sourceProvenance: provenance,
      surface: "cron",
      input: "private task",
      message: "private exact text",
      fireKey: "private-decorated-fire",
      destination: {
        ...principalDestination("U1", "U1"),
        webhook: { binding: "foreign", url: "https://example.test/receive" },
      },
    },
  );
  assert.equal(outcome.authzFailed, true);
  assert.equal(runs, 0);
  assert.equal((await f.built.deliveries.pending("principal")).length, 0);
});

test("private schedule notes and task changes cannot modify an existing shared schedule", async () => {
  const f = await fixture();
  const ordinary = await f.built.app.createCron({
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: ownerScope,
    schedule: { everyMs: 3_600_000 },
    action: "Ordinary task",
    destination: principalDestination("U1", "U1"),
  });
  await f.built.app.grant(testTenant, {
    ownerScopeId: ownerScope,
    ref: `cron:${ordinary.id}`,
    granteeScopeId: "personal:U2",
    permission: "read",
    grantedBy: "U1",
  });
  const stale = f.context();
  await f.protect();
  await assert.rejects(
    f.built.app.updateCron(testTenant, ordinary.id, { action: "Private replacement" }, stale),
    /cannot update a shared schedule/,
  );
  await assert.rejects(
    f.built.app.setCronFireNote(testTenant, ordinary.id, { text: "Private note", at: Date.now() }, stale),
    /cannot update a shared schedule/,
  );
  assert.equal((await f.built.crons.get(ordinary.id))!.action, "Ordinary task");
  assert.equal((await f.built.crons.get(ordinary.id))!.lastFireNote, undefined);
  const personal = await f.built.app.createCron({
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: ownerScope,
    schedule: { everyMs: 3_600_000 },
    action: "Personal task",
    context: f.context(),
    destination: principalDestination("U1", "U1"),
  });
  await assert.rejects(
    f.built.app.setCronDestination(testTenant, personal.id, principalDestination("U2", "U1"), f.context()),
    /personal scope and delivery/,
  );
  await assert.rejects(
    f.built.app.grant(testTenant, {
      ownerScopeId: ownerScope,
      ref: `cron:${personal.id}`,
      granteeScopeId: "personal:U2",
      permission: "read",
      grantedBy: "U1",
    }),
    /explicitly/,
  );
  assert.deepEqual((await f.built.crons.get(personal.id))!.destination, principalDestination("U1", "U1"));
});

test("unchanged schedule controls still inherit private contents before returning them", async () => {
  const f = await fixture();
  await f.protect();
  const destination = { type: "principal", target: "U1", audienceScopeId: ownerScope };
  const cron = await f.built.app.createCron({
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: ownerScope,
    schedule: { everyMs: 3_600_000 },
    action: "Private task",
    title: "Private title",
    context: f.context(),
    destination,
  });
  const shared = await f.built.app.createCron({
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: ownerScope,
    schedule: { everyMs: 3_600_000 },
    action: "Shared task",
    destination: principalDestination("U2", "U1"),
  });
  for (const operation of ["patch", "enabled", "retarget"]) {
    const session = await f.built.sessions.getOrCreateByThread("private-noop-" + operation, "dm", ownerScope);
    const context = {
      ...f.context(),
      sessionId: session.id,
      threadRef: session.threadRef,
      destinations: [{ ...destination, key: "self", label: "me" }],
    };
    let result;
    if (operation === "patch")
      result = await f.control.patchCron(testTenant, cron.id, { title: "Private title" }, context);
    else if (operation === "enabled") result = await f.control.setCronEnabled(testTenant, cron.id, true, context);
    else result = await f.control.retargetCron(testTenant, cron.id, "self", context);
    assert.equal(result.ok, true, operation + JSON.stringify(result));
    assert.equal((await f.built.sessions.get(session.id))!.personalOnly, true);
    await assert.rejects(
      f.built.app.updateCron(
        testTenant,
        shared.id,
        { action: "Private copied task" },
        { privateRead: true, actorId: "U1", scopeId: ownerScope, sessionId: session.id },
      ),
      /personal scope and delivery/,
    );
  }
});

for (const reattach of [false, true])
  test(`monitor ${reattach ? "reattachment" : "creation"} refreshes privacy after computer authorization`, async () => {
    const f = await fixture();
    const registry = createPostgresProcessRegistry(testDatabaseUrl());
    await registry.register({
      processId: "private-monitor",
      sandboxId: "private-monitor-computer",
      scopeId: ownerScope,
      kind: "background",
      command: "long-running report",
      ttlMs: 60_000,
    });
    const base = {
      store: f.built.monitors,
      registry,
      sessions: f.built.sessions,
      sessionId: f.session.id,
      readOutputTail: async () => ({ outputTail: "" }),
      owner: "U1",
      scopeId: ownerScope,
      ownerScopeId: ownerScope,
      threadRef: f.session.threadRef,
      destination: principalDestination("U1", "U1"),
    };
    let existing: string | undefined;
    if (reattach) {
      const result = await createMonitorBroker(base).watch("private-monitor");
      assert.ok(!("completed" in result));
      existing = result.monitorId;
    }
    const broker = createMonitorBroker({
      ...base,
      assertComputerUsable: async () => {
        await f.protect();
      },
    });
    const result = await broker.watch("private-monitor", { instructions: "Private instructions" });
    assert.ok(!("completed" in result));
    if (reattach) assert.equal(result.monitorId, existing);
    const saved = (await f.built.monitors.get(result.monitorId))!;
    assert.equal(saved.personalOnly, true);
    assert.deepEqual(saved.sourceProvenance, provenance);
  });

test("private webhook registration stays hidden from shared context and fires a private conversation", async () => {
  const f = await fixture();
  await f.protect();
  const secret = "private-webhook-secret";
  const result = await f.control.createWebhook(
    { action: "Make a private report", verification: { scheme: "token", secret } },
    { ...f.context(), liveActor: true },
    undefined,
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.webhook.personalOnly, true);
  const shared = await f.built.sessions.getOrCreateByThread("shared-webhook-reader", "channel", "channel:C9");
  assert.equal(
    (await f.control.listWebhooks({ ...f.context(), scopeId: shared.scopeId, sessionId: shared.id })).some(
      (wh) => wh.id === result.webhook.id,
    ),
    false,
  );
  f.built.runtime.start();
  assert.equal(
    (
      await f.built.webhookReceiver.deliver(result.webhook.id, {
        headers: {},
        rawBody: JSON.stringify({ message: "private event" }),
        presentedToken: secret,
      })
    ).status,
    202,
  );
  const [event] = await f.built.app.listWebhookEvents(result.webhook.id, "U1");
  assert.ok(event);
  await settle(async () => !!(await f.built.app.getWebhook(result.webhook.id))?.lastFiredAt);
  const session = await f.built.sessions.getByThread(`webhook:${result.webhook.id}:${event.deliveryId}`);
  assert.equal(session?.personalOnly, true);
  assert.equal(session?.sourceProvenance?.sourceUnknown, true);
  assert.equal((await f.built.deliveries.pending("principal")).length, 1);
  assert.ok((await f.built.deliveries.pending("principal")).every((delivery) => delivery.destination.target === "U1"));
});

test("private loop creation labels both the loop and its bound schedule", async () => {
  const f = await fixture();
  await f.protect();
  let status = 0;
  let body: unknown;
  const res = {
    getHeader() {},
    writeHead(value: number) {
      status = value;
      return this;
    },
    end(value?: string) {
      body = value ? JSON.parse(value) : undefined;
    },
  } as unknown as ApiCtx["res"];
  const route = loopRoutes.find(
    (route) => "method" in route && "path" in route && route.method === "POST" && route.path === "/v1/loops",
  );
  assert.ok(route);
  await route.handle({
    app: f.built.app,
    deps: { loops: f.built.loops },
    capability: f.context(),
    actor: undefined,
    method: "POST",
    pathname: "/v1/loops",
    url: new URL("http://core.test/v1/loops"),
    params: {},
    body: {
      name: "Private loop",
      playbook: "Use private instructions",
      successCondition: "Done",
      schedule: { everyMs: 3_600_000 },
    },
    res,
  } as unknown as ApiCtx);
  assert.equal(status, 200, JSON.stringify(body));
  const created = (body as { loop: { id: string; cronId: string; personalOnly?: true } }).loop;
  assert.equal(created.personalOnly, true);
  assert.equal((await f.built.crons.get(created.cronId))!.personalOnly, true);
  assert.equal((await f.built.loops.store.get(created.id))!.personalOnly, true);
});

test("fire history is withheld when its schedule becomes private during retrieval", async (t) => {
  const f = await fixture();
  const cron = await f.built.app.createCron({
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: ownerScope,
    schedule: { everyMs: 3_600_000 },
    action: "Ordinary task",
    destination: principalDestination("U1", "U1"),
  });
  const reader = await f.built.sessions.getOrCreateByThread("shared-fire-history-reader", "channel", "channel:C9");
  const actual = f.built.app.listCronFires.bind(f.built.app);
  t.mock.method(f.built.app, "listCronFires", async (id: string, options?: Parameters<typeof actual>[1]) => {
    await f.protect();
    await f.built.app.updateCron(testTenant, id, { action: "Private task" }, f.context());
    await f.built.crons.recordFire(id, {
      fireKey: "private-history",
      threadRef: "private-history",
      firedAt: Date.now(),
      reply: "Private fire reply",
    });
    return actual(id, options);
  });
  const result = await f.control.getCronRuns(
    cron.id,
    {},
    { ...f.context(), scopeId: reader.scopeId, sessionId: reader.id },
  );
  assert.equal(result.ok, false);
  assert.equal((await f.built.sessions.get(reader.id))!.personalOnly, undefined);
});

test("webhook event history is withheld after a concurrent private update", async (t) => {
  const f = await fixture();
  const secret = "event-history-private-secret";
  const webhook = await f.built.app.createWebhook({
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: ownerScope,
    action: "Ordinary event task",
    verification: { scheme: "token", secret },
    destination: principalDestination("U1", "U1"),
  });
  const shared = await f.built.sessions.getOrCreateByThread("shared-event-history", "channel", "channel:C9");
  const actual = f.built.app.listWebhookEvents.bind(f.built.app);
  t.mock.method(f.built.app, "listWebhookEvents", async (id: string, viewer: string) => {
    await f.protect();
    await f.built.app.updateWebhook(id, { action: "Private event task" }, f.context());
    await f.built.webhookReceiver.deliver(id, {
      headers: {},
      rawBody: JSON.stringify({ private: "event contents" }),
      presentedToken: secret,
    });
    return actual(id, viewer);
  });
  let status = 0;
  let body: unknown;
  const res = {
    getHeader() {},
    writeHead(value: number) {
      status = value;
      return this;
    },
    end(value?: string) {
      body = value ? JSON.parse(value) : undefined;
    },
  } as unknown as ApiCtx["res"];
  const route = webhookRoutes.find((route) => "path" in route && route.path === "/v1/webhooks/:id/events");
  assert.ok(route);
  await route.handle({
    app: f.built.app,
    capability: { ...f.context(), scopeId: shared.scopeId, sessionId: shared.id },
    actor: undefined,
    method: "GET",
    pathname: `/v1/webhooks/${webhook.id}/events`,
    url: new URL("http://core.test/events"),
    params: { id: webhook.id },
    res,
  } as unknown as ApiCtx);
  assert.equal(status, 404);
  assert.deepEqual(body, { error: "not_found" });
  assert.equal((await f.built.sessions.get(shared.id))!.personalOnly, undefined);
});

test("ordinary schedule history cannot expose a fire that acquired private context", async () => {
  const f = await fixture();
  const cron = await f.built.app.createCron({
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: ownerScope,
    schedule: { everyMs: 3_600_000 },
    action: "Ordinary task",
    destination: principalDestination("U1", "U1"),
  });
  const execution = await f.built.sessions.getOrCreateByThread("late-private-fire", "dm", ownerScope);
  await f.built.sessions.recordContextProvenance(execution.id, ownerScope, { ...provenance, personalOnly: true });
  await f.built.crons.recordFire(cron.id, {
    fireKey: "late-private-fire",
    threadRef: execution.threadRef,
    sessionId: execution.id,
    firedAt: Date.now(),
    reply: "PrivateHistorySpruce7301",
  });
  const reader = await f.built.sessions.getOrCreateByThread("ordinary-history-caller", "dm", ownerScope);
  const caller = { ...f.context(), sessionId: reader.id, threadRef: reader.threadRef };
  const refused = await f.control.getCronRuns(
    cron.id,
    {},
    { ...caller, privateRead: false, computer: { personalOnly: false } },
  );
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.notEqual((await f.built.sessions.get(reader.id))!.personalOnly, true);
  const allowed = await f.control.getCronRuns(cron.id, {}, caller);
  assert.ok(allowed.ok, JSON.stringify(allowed));
  assert.equal(allowed.runs[0]?.reply, "PrivateHistorySpruce7301");
  assert.equal((await f.built.sessions.get(reader.id))!.personalOnly, true);
  assert.equal((await f.built.crons.get(cron.id))!.personalOnly, undefined);
  await f.built.crons.recordFire(cron.id, {
    fireKey: "unresolved-private-fire",
    threadRef: "deleted-private-execution",
    firedAt: Date.now(),
    reply: "UnknownPrivateHistorySpruce7301",
  });
  const unverifiable = await f.control.getCronRuns(cron.id, {}, caller);
  assert.equal(unverifiable.ok, false, JSON.stringify(unverifiable));
});

for (const scenario of ["refusal", "queued", "owner"] as const) {
  test(`late private execution protects the ${scenario} failure notice`, async () => {
    const f = await fixture();
    const execution = await f.built.sessions.getOrCreateByThread(`late-private-notice-${scenario}`, "dm", ownerScope);
    let executed = false;
    const work = runTrigger(
      {
        identity: f.built.identity,
        deliveries: f.built.deliveries,
        sessions: f.built.sessions,
        idempotency: createIdempotencyStore(testMap()),
        run: async () => {
          executed = true;
          await f.built.sessions.recordContextProvenance(execution.id, ownerScope, {
            ...provenance,
            personalOnly: true,
          });
          return scenario === "queued"
            ? { status: "queued" as const, runId: "queued-private-run" }
            : { status: "refused" as const, reason: "PrivateFailureSpruce7301", sessionId: execution.id };
        },
      },
      {
        owner: "U1",
        ownerScopeId: ownerScope,
        surface: "cron",
        input: "Ordinary template",
        fireKey: `late-private-notice-${scenario}`,
        threadRef: execution.threadRef,
        destination: principalDestination(scenario === "owner" ? "U1" : "U2", "U1"),
        errorNotice: (reason) => `Failed: ${reason}`,
      },
    );
    if (scenario === "owner") {
      assert.equal((await work).status, "refused");
      const [notice] = await f.built.deliveries.pending("principal");
      assert.equal(notice?.destination.target, "U1");
      assert.equal(notice?.provenance?.contextProvenance?.personalOnly, true);
      assert.ok(notice?.text.includes("PrivateFailureSpruce7301"));
    } else {
      await assert.rejects(work, /Private scheduled output cannot use this scope or destination/);
      assert.deepEqual(await f.built.deliveries.pending("principal"), []);
    }
    assert.equal(executed, true);
  });
}
