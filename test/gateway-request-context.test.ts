import "./support/auto-fake-sprites.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { createAgent } from "../src/agent/agent-run.ts";
import { createModelRoutes } from "../src/model/model-route.ts";
import { probeModel } from "../src/model/model-runtime.ts";
import { gatewayActorId } from "../src/model/provider-endpoints.ts";
import { withResolvedRuntime } from "../src/agent/runtime-choice.ts";
import type { AgentTurnInput } from "../src/agent/agent.ts";
import { storedItem } from "../src/sessions/items.ts";
import { getRequiredModel } from "../src/model/pi-models.ts";
import { withModelRequestContext } from "../src/model/request-context.ts";
import { mintCapabilityToken } from "../src/auth/capability-token.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import type { Config } from "../src/config.ts";
import type { Session } from "../src/types.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";
import { settle } from "./support/settle.ts";
import { anthropicStream, contextHeaders, recordRequests } from "./support/gateway-stream.ts";
import { testTenant as tenant } from "./support/test-tenant.ts";

const gateway = {
  url: "https://gateway.test",
  apiKey: "gateway-key",
  apiKeyHeader: "api-key",
  models: { "claude-haiku-4-5": "router/haiku", "claude-haiku-5-5": "router/haiku-5-5" },
  actorKey: TEST_CAPABILITY_SECRET,
};

const pseudonym = (id: string) => gatewayActorId(id, TEST_CAPABILITY_SECRET);

const cronContext = {
  sessionId: "session-cron",
  actorId: "owner@example.com",
  scopeId: "channel:C123",
  origin: "cron" as const,
};

const cronHeaders = {
  "x-qm-session-id": "session-cron",
  "x-qm-actor": pseudonym("owner@example.com"),
  "x-qm-scope": "channel:C123",
  "x-qm-origin": "cron",
};

function turn(extra: Partial<AgentTurnInput> = {}): AgentTurnInput {
  let seq = 0;
  return {
    session: { id: "session-cron" } as Session,
    input: "hello",
    systemPrompt: "Reply ok.",
    history: [],
    tools: {} as AgentTurnInput["tools"],
    scopeLabel: "channel:C123",
    orgScopeId: "org:test",
    emit: async (item) => storedItem(item, { sessionId: "session-cron", seq: seq++, createdAt: 0 }),
    recordModelCall: () => {},
    cancel: AbortSignal.timeout(10_000),
    ...extra,
  };
}

test("a gateway turn carries the session, actor, scope, purpose and origin it works for", async (t) => {
  const requests = recordRequests(t);
  const harness = createAgent({
    routes: createModelRoutes({ defaultModelId: "claude-haiku-4-5", modelGateway: gateway }),
  });

  assert.equal((await withModelRequestContext(cronContext, () => harness.runTurn(turn()))).reply, "ok");
  assert.equal(requests.at(-1)!.url, "https://gateway.test/v1/messages");
  assert.equal(requests.at(-1)!.headers.get("api-key"), "gateway-key");
  assert.deepEqual(contextHeaders(requests.at(-1)!.headers), { ...cronHeaders, "x-qm-purpose": "turn" });

  await withModelRequestContext({ sessionId: "session-bare" }, () => harness.runTurn(turn()));
  assert.deepEqual(contextHeaders(requests.at(-1)!.headers), {
    "x-qm-session-id": "session-bare",
    "x-qm-purpose": "turn",
  });
});

test("the gateway gets keyed pseudonyms for people, and none without a key", async (t) => {
  const requests = recordRequests(t);
  const personal = { ...cronContext, scopeId: "personal:owner@example.com" };
  await withModelRequestContext(personal, () =>
    createAgent({ routes: createModelRoutes({ defaultModelId: "claude-haiku-4-5", modelGateway: gateway }) }).runTurn(
      turn(),
    ),
  );
  assert.deepEqual(contextHeaders(requests.at(-1)!.headers), {
    ...cronHeaders,
    "x-qm-scope": `personal:${pseudonym("owner@example.com")}`,
    "x-qm-purpose": "turn",
  });
  assert.ok(!JSON.stringify([...requests.at(-1)!.headers]).includes("owner@example.com"));

  const { actorKey: _actorKey, ...unkeyed } = gateway;
  await withModelRequestContext(personal, () =>
    createAgent({ routes: createModelRoutes({ defaultModelId: "claude-haiku-4-5", modelGateway: unkeyed }) }).runTurn(
      turn(),
    ),
  );
  assert.deepEqual(contextHeaders(requests.at(-1)!.headers), {
    "x-qm-session-id": "session-cron",
    "x-qm-origin": "cron",
    "x-qm-purpose": "turn",
  });
});

test("context values the credential broker could not attest are left off", async (t) => {
  const requests = recordRequests(t);
  const harness = createAgent({
    routes: createModelRoutes({ defaultModelId: "claude-haiku-4-5", modelGateway: gateway }),
  });

  for (const actorId of ["Owner Example", "a".repeat(257), "owner@example.com\r\nx-qm-scope: org:other"]) {
    await withModelRequestContext({ ...cronContext, actorId }, () => harness.runTurn(turn()));
    assert.deepEqual(contextHeaders(requests.at(-1)!.headers), {
      "x-qm-session-id": "session-cron",
      "x-qm-scope": "channel:C123",
      "x-qm-origin": "cron",
      "x-qm-purpose": "turn",
    });
  }
  await withModelRequestContext({ sessionId: "", scopeId: "channel:café", origin: "cron" }, () =>
    harness.runTurn(turn()),
  );
  assert.deepEqual(contextHeaders(requests.at(-1)!.headers), { "x-qm-origin": "cron", "x-qm-purpose": "turn" });
});

test("turns on a user's or the org's own provider key send no request context", async (t) => {
  const requests = recordRequests(t);
  const harness = createAgent({
    routes: createModelRoutes({ defaultModelId: "claude-haiku-4-5", apiKey: "org-key", modelGateway: gateway }),
  });

  await withModelRequestContext(cronContext, async () => {
    await harness.runTurn(turn({ runtime: { modelId: "claude-opus-4-8" } }));
    await harness.runTurn(turn({ providerKeys: { anthropic: "user-key" } }));
  });
  assert.deepEqual(
    requests.map((request) => [request.url, request.headers.get("x-api-key"), contextHeaders(request.headers)]),
    [
      ["https://api.anthropic.com/v1/messages", "org-key", {}],
      ["https://api.anthropic.com/v1/messages", "user-key", {}],
    ],
  );
});

test("every helper call keeps its work's context and names its own purpose", async (t) => {
  const requests = recordRequests(t);
  const harness = createAgent({
    routes: createModelRoutes({ defaultModelId: "claude-haiku-4-5", modelGateway: gateway }),
    detectModelId: "claude-haiku-4-5",
    titleModelId: "claude-haiku-4-5",
    judgeModelId: "claude-haiku-4-5",
  });
  const session = { id: "session-cron" } as Session;
  const reportItem = storedItem(
    { kind: "UserMessage", text: "report" },
    { sessionId: "session-cron", seq: 1, createdAt: 0 },
  );
  const helpers: Record<string, () => Promise<unknown>> = {
    detect: () =>
      harness.shouldRespond!({
        session,
        message: "anyone around?",
        recentContext: "",
        systemPrompt: "",
        history: [],
        recordModelCall: () => {},
      }),
    compaction: () =>
      harness.compactHistory!({
        session,
        history: [reportItem],
        recordModelCall: () => {},
      }),
    title: () => harness.generateTitle!("User:\nSummarize the nightly report"),
    approval_summary: () => harness.summarizeApproval!("rm -rf build", "deletes files"),
    security_screen: () =>
      harness.screenSecurity!({ payload: "[]", signal: AbortSignal.timeout(10_000), recordModelCall: () => {} }),
    judge: () => harness.judge!("Judge the answer.", "answer"),
    memory_capture: () => harness.oneShot!("Extract facts.", "User said: hi", "memory_capture"),
    ack_emoji: () => harness.pickAckEmoji!("can you check the deploy?", ["eyes"]),
    probe: () => probeModel(getRequiredModel("claude-haiku-4-5"), {}, AbortSignal.timeout(10_000), false, gateway),
  };

  for (const [purpose, call] of Object.entries(helpers)) {
    await withModelRequestContext(cronContext, call).catch(() => undefined);
    assert.deepEqual(contextHeaders(requests.at(-1)!.headers), { ...cronHeaders, "x-qm-purpose": purpose }, purpose);
  }
});

test("the goal governor judges with its turn's context", async (t) => {
  const requests = recordRequests(t);
  const pi = createAgent({
    routes: createModelRoutes({ defaultModelId: "claude-haiku-4-5", modelGateway: gateway }),
    judgeModelId: "claude-haiku-4-5",
  });
  const adapter = {
    ...pi,
    runTurn: async (input: AgentTurnInput) => {
      await input.governGoal!({ objective: "ship the release", trigger: "checkpoint", recentWork: "" }).catch(
        () => undefined,
      );
      return { reply: "" };
    },
  };
  const router = withResolvedRuntime(
    adapter,
    () => ({ modelId: "claude-haiku-4-5" }),
    async () => ({ modelId: "claude-haiku-4-5" }),
  );

  await withModelRequestContext(cronContext, () => router.runTurn(turn()));
  assert.deepEqual(contextHeaders(requests.at(-1)!.headers), { ...cronHeaders, "x-qm-purpose": "judge" });
});

async function listen(t: TestContext, handler: RequestListener): Promise<string> {
  const server = httpServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function gatewayApp(
  t: TestContext,
  overrides: Partial<Config> = {},
  hold?: (headers: Record<string, unknown>) => Promise<void>,
) {
  const seen: Array<Record<string, unknown>> = [];
  const url = await listen(t, async (req, res) => {
    for await (const chunk of req) void chunk;
    if (req.method !== "POST") {
      res.writeHead(404);
      return res.end();
    }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => name.startsWith("x-qm-")));
    seen.push(headers);
    await hold?.(headers);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(anthropicStream('{"decision":"auto"}'));
  });
  const config = testConfig({
    modelId: "claude-haiku-4-5",
    titleModelId: "claude-haiku-4-5",
    detectModelId: "claude-haiku-4-5",
    judgeModelId: "claude-haiku-4-5",
    ...overrides,
    modelGateway: { ...(overrides.modelGateway ?? gateway), url },
  });
  const sent = (purpose: string, sessionId?: string) =>
    seen.find(
      (headers) =>
        headers["x-qm-purpose"] === purpose && (sessionId === undefined || headers["x-qm-session-id"] === sessionId),
    );
  const built = buildApp(config);
  built.runtime.start();
  t.after(() => built.runtime.stop());
  return { config, built, seen, sent };
}

test("app turns and their helper calls tell the gateway which session they serve", async (t) => {
  const { built, seen, sent } = await gatewayApp(t);

  const dm = await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:context" },
    conversationHeader: "You are in a direct message.",
    text: "Summarize the nightly report",
  });
  await settle(async () => !!sent("title") && !!sent("memory_capture"));
  const session = (await built.sessions.get(dm.sessionId!))!;
  const parent = {
    "x-qm-session-id": session.id,
    "x-qm-actor": pseudonym("U1"),
    "x-qm-scope": `personal:${pseudonym("U1")}`,
  };
  assert.deepEqual(sent("security_screen"), {
    "x-qm-actor": pseudonym("U1"),
    "x-qm-scope": `personal:${pseudonym("U1")}`,
    "x-qm-purpose": "security_screen",
  });
  assert.deepEqual(sent("turn"), { ...parent, "x-qm-origin": "conversation", "x-qm-purpose": "turn" });
  assert.deepEqual(sent("title"), { ...parent, "x-qm-origin": "conversation", "x-qm-purpose": "title" });
  assert.deepEqual(sent("memory_capture"), {
    ...parent,
    "x-qm-origin": "conversation",
    "x-qm-purpose": "memory_capture",
  });
  const titles = () => seen.filter((headers) => headers["x-qm-purpose"] === "title");
  const before = titles().length;
  await built.app.regenerateTitle(session.id, "U1");
  assert.deepEqual(titles().slice(before), [{ ...parent, "x-qm-origin": "conversation", "x-qm-purpose": "title" }]);

  const ambient = await built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "channel", threadRef: "ch:C1:context", channelRef: "C1", audience: [{ externalId: "U1" }] },
    text: "anyone around?",
    origin: { kind: "ambient" },
  });
  const channel = (await built.sessions.get(ambient.sessionId!))!;
  assert.deepEqual(sent("detect"), {
    "x-qm-session-id": channel.id,
    "x-qm-actor": pseudonym("U1"),
    "x-qm-scope": channel.scopeId,
    "x-qm-origin": "conversation",
    "x-qm-purpose": "detect",
  });

  await built.app.setChannelPolicy("C2", "", "U-admin", undefined, undefined, true);
  await built.app.ingestSurfaceEvents([
    { container: "C2", ts: "1.0", authorId: "U1", text: "did the launch slip?", createdAt: 1 },
  ]);
  await built.app.judgeAmbientContainer("slack", "C2");
  assert.deepEqual(sent("ambient_judge"), { "x-qm-scope": "channel:C2", "x-qm-purpose": "ambient_judge" });

  const cron = await built.sessions.getOrCreateByThread("agent:main:cron:nightly", "dm", session.scopeId);
  const child = await built.sessions.getOrCreateByThread("agent:main:subagent:context", "dm", session.scopeId);
  const conversation = { kind: "dm" as const, threadRef: child.threadRef };
  const actor = { id: "U1", type: "internal" as const };
  await built.sessions.setParentSession(child.id, cron.id);
  await built.sessions.addParticipant(child.id, "U1");
  await built.sessions.setSpawnMeta(child.id, {
    surface: "test",
    actor,
    conversation: { ...conversation, audience: [actor] },
  });
  assert.equal(
    (await built.app.turn({ surface: "test", actor: { externalId: "U1" }, conversation, text: "check the report" }))
      .status,
    "ok",
  );
  assert.deepEqual(sent("turn", child.id), {
    ...parent,
    "x-qm-session-id": child.id,
    "x-qm-origin": "cron",
    "x-qm-purpose": "turn",
  });
});

test("API work carries its token's turn, the admin replaying screens, or the memory writer", async (t) => {
  const { config, built, sent } = await gatewayApp(t);
  const server = createInsecureTestServer(built.app, serverDeps(config, built));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await built.memory.capture("personal:U2", ["Prefers tea"], Date.now(), { actorId: "U2", context: "conversation" });
  assert.deepEqual(sent("memory_classification"), {
    "x-qm-actor": pseudonym("U2"),
    "x-qm-scope": `personal:${pseudonym("U2")}`,
    "x-qm-purpose": "memory_classification",
  });

  const capability = await mintCapabilityToken(
    {
      actorId: "U1",
      scopeId: "personal:U1",
      sessionId: "session-agent",
      origin: "webhook",
      memory: { write: "personal:U1", read: ["personal:U1"] },
      exp: Date.now() + 60_000,
    },
    TEST_CAPABILITY_SECRET,
  );
  const captured = await fetch(`${base}/v1/memory/facts`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-capability": capability },
    body: JSON.stringify({ facts: ["Prefers metric units"] }),
  });
  assert.equal(captured.status, 200, await captured.text());
  assert.deepEqual(sent("memory_classification", "session-agent"), {
    "x-qm-session-id": "session-agent",
    "x-qm-actor": pseudonym("U1"),
    "x-qm-scope": `personal:${pseudonym("U1")}`,
    "x-qm-origin": "webhook",
    "x-qm-purpose": "memory_classification",
  });

  const enabled = await fetch(`${base}/v1/admin/model-registry/claude-haiku-4-5/enable`, {
    method: "POST",
    headers: { "x-admin-actor": "admin-alice@default-org", "content-type": "application/json" },
    body: JSON.stringify({ provider: "anthropic", verify: true }),
  });
  assert.equal(enabled.status, 200, await enabled.text());
  assert.deepEqual(sent("probe"), {
    "x-qm-actor": pseudonym("admin-alice"),
    "x-qm-scope": "org:default-org",
    "x-qm-purpose": "probe",
  });
});

test("debounced memory capture keeps the context of the turn it came from, even while turns overlap", async (t) => {
  let release!: () => void;
  const bothTurnsInFlight = new Promise<void>((resolve) => (release = resolve));
  let turnsInFlight = 0;
  const { built, sent } = await gatewayApp(t, { memoryCaptureQuietMs: 200 }, async (headers) => {
    if (headers["x-qm-purpose"] !== "turn") return;
    if (++turnsInFlight === 2) release();
    await bothTurnsInFlight;
  });
  const sessions = Object.fromEntries(
    await Promise.all(
      ["U1", "U2"].map(async (id) => {
        const result = await built.app.turn({
          surface: "test",
          actor: { externalId: id },
          conversation: { kind: "dm", threadRef: `dm:${id}:debounce` },
          text: "Remember that I prefer short replies",
        });
        return [id, result.sessionId] as const;
      }),
    ),
  );
  await settle(async () => Object.values(sessions).every((id) => !!sent("memory_capture", id)));
  for (const [id, sessionId] of Object.entries(sessions))
    assert.deepEqual(sent("memory_capture", sessionId), {
      "x-qm-session-id": sessionId,
      "x-qm-actor": pseudonym(id),
      "x-qm-scope": `personal:${pseudonym(id)}`,
      "x-qm-origin": "conversation",
      "x-qm-purpose": "memory_capture",
    });
});

test("decision rules on the gateway carry the same keyed actor as the turn they judge", async (t) => {
  const { actorKey: _actorKey, ...envGateway } = gateway;
  const { built, sent } = await gatewayApp(t, { modelGateway: envGateway });
  const by = { actorId: "admin@example.com" };
  await built.decisions!.saveProvider(tenant, { id: "gw", protocol: "chat-completions" }, by);
  await built.decisions!.saveRule(
    tenant,
    {
      id: "router",
      hook: "turn_start",
      question: "Is this a hard task?",
      options: { keep: { description: "ordinary", action: "keep" } },
      model: { provider: "gw", model: "example/decision-model" },
      mode: "observe",
      onError: "keep",
    },
    by,
  );
  await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:decision" },
    text: "plan the migration",
  });
  await settle(async () => !!sent("decision"));
  assert.equal(sent("decision")!["x-qm-actor"], pseudonym("U1"));
  assert.equal(sent("decision")!["x-qm-actor"], sent("turn")!["x-qm-actor"]);
});
