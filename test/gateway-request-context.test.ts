import "./support/auto-fake-sprites.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { createPiHarness, probeModel } from "../src/harness/pi-harness.ts";
import { createHarnessRouter } from "../src/harness/harness-router.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { getRequiredModel } from "../src/model/pi-models.ts";
import { withModelRequestContext } from "../src/model/request-context.ts";
import { mintCapabilityToken } from "../src/auth/capability-token.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { SECURITY_SCREEN_STEP } from "../src/security/security-posture.ts";
import type { Config } from "../src/config.ts";
import type { Session, SessionEntry } from "../src/types.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";
import { settle } from "./support/settle.ts";
import { anthropicStream, contextHeaders, recordRequests } from "./support/gateway-stream.ts";

const gateway = {
  url: "https://gateway.test",
  apiKey: "gateway-key",
  apiKeyHeader: "api-key",
  models: { "claude-haiku-4-5": "router/haiku", "claude-haiku-5-5": "router/haiku-5-5" },
};

const cronContext = {
  sessionId: "session-cron",
  actorId: "owner@example.com",
  scopeId: "channel:C123",
  origin: "cron" as const,
};

const cronHeaders = {
  "x-qm-session-id": "session-cron",
  "x-qm-actor": "owner@example.com",
  "x-qm-scope": "channel:C123",
  "x-qm-origin": "cron",
};

function turn(extra: Partial<HarnessTurnInput> = {}): HarnessTurnInput {
  let seq = 0;
  return {
    session: { id: "session-cron" } as Session,
    input: "hello",
    systemPrompt: "Reply ok.",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "channel:C123",
    orgScopeId: "org:test",
    emit: async (entry) => ({ ...entry, sessionId: "session-cron", seq: seq++, parentSeq: null, createdAt: 0 }),
    recordModelCall: () => {},
    cancel: AbortSignal.timeout(10_000),
    ...extra,
  };
}

test("a gateway turn carries the session, actor, scope, purpose and origin it works for", async (t) => {
  const requests = recordRequests(t);
  const harness = createPiHarness({ defaultModelId: "claude-haiku-4-5", modelGateway: gateway });

  assert.equal((await withModelRequestContext(cronContext, () => harness.turns.runTurn(turn()))).reply, "ok");
  assert.equal(requests.at(-1)!.url, "https://gateway.test/v1/messages");
  assert.equal(requests.at(-1)!.headers.get("api-key"), "gateway-key");
  assert.deepEqual(contextHeaders(requests.at(-1)!.headers), { ...cronHeaders, "x-qm-purpose": "turn" });

  await withModelRequestContext({ sessionId: "session-bare" }, () => harness.turns.runTurn(turn()));
  assert.deepEqual(contextHeaders(requests.at(-1)!.headers), {
    "x-qm-session-id": "session-bare",
    "x-qm-purpose": "turn",
  });
});

test("context values the credential broker could not attest are left off", async (t) => {
  const requests = recordRequests(t);
  const harness = createPiHarness({ defaultModelId: "claude-haiku-4-5", modelGateway: gateway });

  for (const actorId of ["Owner Example", "a".repeat(257), "owner@example.com\r\nx-qm-scope: org:other"]) {
    await withModelRequestContext({ ...cronContext, actorId }, () => harness.turns.runTurn(turn()));
    assert.deepEqual(contextHeaders(requests.at(-1)!.headers), {
      "x-qm-session-id": "session-cron",
      "x-qm-scope": "channel:C123",
      "x-qm-origin": "cron",
      "x-qm-purpose": "turn",
    });
  }
  await withModelRequestContext({ sessionId: "", scopeId: "channel:café", origin: "cron" }, () =>
    harness.turns.runTurn(turn()),
  );
  assert.deepEqual(contextHeaders(requests.at(-1)!.headers), { "x-qm-origin": "cron", "x-qm-purpose": "turn" });
});

test("turns on a user's or the org's own provider key send no request context", async (t) => {
  const requests = recordRequests(t);
  const harness = createPiHarness({ defaultModelId: "claude-haiku-4-5", apiKey: "org-key", modelGateway: gateway });

  await withModelRequestContext(cronContext, async () => {
    await harness.turns.runTurn(turn({ runtime: { modelId: "claude-opus-4-8" } }));
    await harness.turns.runTurn(turn({ providerKeys: { anthropic: "user-key" } }));
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
  const harness = createPiHarness({
    defaultModelId: "claude-haiku-4-5",
    detectModelId: "claude-haiku-4-5",
    titleModelId: "claude-haiku-4-5",
    judgeModelId: "claude-haiku-4-5",
    modelGateway: gateway,
  });
  const session = { id: "session-cron" } as Session;
  const entry = { sessionId: "session-cron", seq: 1, parentSeq: null, type: "user", payload: { text: "report" } };
  const helpers: Record<string, () => Promise<unknown>> = {
    detect: () =>
      harness.models.shouldRespond!({
        session,
        message: "anyone around?",
        recentContext: "",
        systemPrompt: "",
        history: [],
        recordModelCall: () => {},
      }),
    compaction: () =>
      harness.models.compactHistory!({
        session,
        history: [{ ...entry, scopeLabel: "channel:C123", createdAt: 0 } as SessionEntry],
        recordModelCall: () => {},
      }),
    title: () => harness.models.generateTitle!("User:\nSummarize the nightly report"),
    approval_summary: () => harness.models.summarizeApproval!("rm -rf build", "deletes files"),
    security_screen: () =>
      harness.models.screenSecurity!({ payload: "[]", signal: AbortSignal.timeout(10_000), recordModelCall: () => {} }),
    judge: () => harness.models.judge!("Judge the answer.", "answer"),
    memory_capture: () => harness.models.oneShot!("Extract facts.", "User said: hi", "memory_capture"),
    ack_emoji: () => harness.models.pickAckEmoji!("can you check the deploy?", ["eyes"]),
    probe: () => probeModel(getRequiredModel("claude-haiku-4-5"), {}, AbortSignal.timeout(10_000), false, gateway),
  };

  for (const [purpose, call] of Object.entries(helpers)) {
    await withModelRequestContext(cronContext, call).catch(() => undefined);
    assert.deepEqual(contextHeaders(requests.at(-1)!.headers), { ...cronHeaders, "x-qm-purpose": purpose }, purpose);
  }
});

test("the goal governor judges with its turn's context", async (t) => {
  const requests = recordRequests(t);
  const pi = createPiHarness({
    defaultModelId: "claude-haiku-4-5",
    judgeModelId: "claude-haiku-4-5",
    modelGateway: gateway,
  });
  const adapter = {
    ...pi,
    turns: {
      runTurn: async (input: HarnessTurnInput) => {
        await input.governGoal!({ objective: "ship the release", trigger: "checkpoint", recentWork: "" }).catch(
          () => undefined,
        );
        return { reply: "" };
      },
    },
  };
  const router = createHarnessRouter(new Map([["pi", adapter]]), adapter, async () => ({
    harnessId: "pi",
    modelId: "claude-haiku-4-5",
  }));

  await withModelRequestContext(cronContext, () => router.turns.runTurn(turn()));
  assert.deepEqual(contextHeaders(requests.at(-1)!.headers), { ...cronHeaders, "x-qm-purpose": "judge" });
});

async function listen(t: TestContext, handler: RequestListener): Promise<string> {
  const server = httpServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("the ack emoji call never follows a gateway redirect to another origin", async (t) => {
  const redirected: string[] = [];
  const elsewhere = await listen(t, (req, res) => {
    redirected.push(req.url!);
    res.end();
  });
  let answered = 0;
  const url = await listen(t, (_req, res) => {
    answered++;
    res.writeHead(307, { location: `${elsewhere}/v1/messages` });
    res.end();
  });
  const harness = createPiHarness({ defaultModelId: "claude-haiku-4-5", modelGateway: { ...gateway, url } });

  await withModelRequestContext(cronContext, () => harness.models.pickAckEmoji!("can you check the deploy?", ["eyes"]));
  assert.equal(answered, 1);
  assert.deepEqual(redirected, []);
});

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
    harness: "pi",
    modelId: "claude-haiku-4-5",
    titleModelId: "claude-haiku-4-5",
    detectModelId: "claude-haiku-4-5",
    judgeModelId: "claude-haiku-4-5",
    modelGateway: { ...gateway, url },
    ...overrides,
  });
  const sent = (purpose: string, sessionId?: string) =>
    seen.find(
      (headers) =>
        headers["x-qm-purpose"] === purpose && (sessionId === undefined || headers["x-qm-session-id"] === sessionId),
    );
  return { config, built: buildApp(config), seen, sent };
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
  const parent = { "x-qm-session-id": session.id, "x-qm-actor": "U1", "x-qm-scope": session.scopeId };
  assert.deepEqual(sent("security_screen"), {
    "x-qm-actor": "U1",
    "x-qm-scope": session.scopeId,
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
    unprompted: true,
  });
  const channel = (await built.sessions.get(ambient.sessionId!))!;
  assert.deepEqual(sent("detect"), {
    "x-qm-session-id": channel.id,
    "x-qm-actor": "U1",
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

  await built.memory.capture("personal:U2", ["Prefers tea"], Date.now(), "U2");
  assert.deepEqual(sent("memory_classification"), {
    "x-qm-actor": "U2",
    "x-qm-scope": "personal:U2",
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
    "x-qm-actor": "U1",
    "x-qm-scope": "personal:U1",
    "x-qm-origin": "webhook",
    "x-qm-purpose": "memory_classification",
  });

  const screened = await built.sessions.getOrCreateByThread("dm:U3:screened", "dm", "personal:U3");
  await built.sessions.recordLlmRequest(screened.id, {
    turnSeq: null,
    step: SECURITY_SCREEN_STEP,
    model: "claude-haiku-4-5",
    scopeLabel: "personal:U3",
    promptEnvelope: { system: "boundary", messages: [{ role: "user", content: "an ordinary tool result" }] },
  });
  const replay = await fetch(`${base}/v1/admin/scopes/org%3Adefault-org/auto-flagger/test`, {
    method: "POST",
    headers: { "x-admin-actor": "admin-alice@default-org", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(replay.status, 200, await replay.text());
  assert.deepEqual(sent("security_screen"), {
    "x-qm-actor": "admin-alice",
    "x-qm-scope": "org:default-org",
    "x-qm-purpose": "security_screen",
  });

  const enabled = await fetch(`${base}/v1/admin/model-registry/claude-haiku-4-5/enable`, {
    method: "POST",
    headers: { "x-admin-actor": "admin-alice@default-org", "content-type": "application/json" },
    body: JSON.stringify({ provider: "anthropic", verify: true }),
  });
  assert.equal(enabled.status, 200, await enabled.text());
  assert.deepEqual(sent("probe"), {
    "x-qm-actor": "admin-alice",
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
      "x-qm-actor": id,
      "x-qm-scope": `personal:${id}`,
      "x-qm-origin": "conversation",
      "x-qm-purpose": "memory_capture",
    });
});
