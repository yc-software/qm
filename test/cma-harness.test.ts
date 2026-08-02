import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CMA_NATIVE_TOOL_NAMES,
  cmaContextKey,
  cmaCustomTools,
  cmaHarnessConfigOptions,
  createCmaHarness,
  type CmaHarnessOptions,
  type CmaSessionRecord,
} from "../src/harness/cma-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { NonRetryableTurnError } from "../src/core/turn-error.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { ScopeId, Session, SessionEntry } from "../src/types.ts";
import type { Config } from "../src/config.ts";
import { settle } from "./support/settle.ts";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";

type FakeEvent = Record<string, unknown>;

interface FakeCmaState {
  url: string;
  workQueue: Array<{ id: string; sessionId: string }>;
  workAcked: string[];
  workStopped: string[];
  workHeartbeats: number;
  workAuth: string[];
  sequence: string[];
  emitLater?: (frames: FakeEvent[], ms: number) => void;
  agentCreates: Array<Record<string, unknown>>;
  messageCreates: Array<Record<string, unknown>>;
  createBodies: Array<Record<string, unknown>>;
  createHeaders: Array<Record<string, string | string[] | undefined>>;
  eventPosts: Array<{ sessionId: string; events: FakeEvent[] }>;
  toolUpdates: Array<{ sessionId: string; tools: unknown[] }>;
  deleted: string[];
  listedEvents: FakeEvent[];
  status: string;
  streams: number;
  createStatus: number;
  failEventsPosts: number;
  failEventsPostsAfterApply: number;
}

function startFakeCma(
  onEvents: (events: FakeEvent[], state: FakeCmaState) => FakeEvent[],
): Promise<{ state: FakeCmaState; close: () => Promise<void> }> {
  const state: FakeCmaState = {
    url: "",
    workQueue: [],
    workAcked: [],
    workStopped: [],
    workHeartbeats: 0,
    workAuth: [],
    sequence: [],
    agentCreates: [],
    messageCreates: [],
    createBodies: [],
    createHeaders: [],
    eventPosts: [],
    toolUpdates: [],
    deleted: [],
    listedEvents: [],
    status: "idle",
    streams: 0,
    createStatus: 200,
    failEventsPosts: 0,
    failEventsPostsAfterApply: 0,
  };
  let sessionCount = 0;
  let agentCount = 0;
  let sse: ServerResponse | null = null;
  const body = (req: import("node:http").IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk: Buffer) => (data += chunk.toString()));
      req.on("end", () => resolve(data));
    });
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const emit = (frames: FakeEvent[]) => {
    for (const frame of frames) {
      if (typeof frame.type === "string" && !frame.type.startsWith("event_")) state.listedEvents.push(frame);
      sse?.write(`data: ${JSON.stringify(frame)}\n\n`);
    }
  };
  state.emitLater = (frames, ms) => setTimeout(() => emit(frames), ms).unref();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const work = /^\/v1\/environments\/env_1\/work\/(?:poll$|([^/]+)\/(ack|heartbeat|stop)$)/.exec(path);
    if (work) {
      if (path.endsWith("/work/poll")) {
        state.workAuth.push(String(req.headers.authorization ?? ""));
        const item = state.workQueue.shift();
        if (!item) return json(res, 204, null);
        return json(res, 200, {
          type: "work",
          id: item.id,
          state: "queued",
          data: { type: "session", id: item.sessionId },
        });
      }
      const workId = work[1]!;
      if (work[2] === "ack") {
        state.workAcked.push(workId);
        state.sequence.push(`ack:${workId}`);
        return json(res, 200, { type: "work", id: workId, state: "starting", data: { type: "session", id: "" } });
      }
      if (work[2] === "heartbeat") {
        state.workHeartbeats++;
        return json(res, 200, { type: "work_heartbeat", last_heartbeat: `hb_${state.workHeartbeats}` });
      }
      state.workStopped.push(workId);
      state.sequence.push(`stop:${workId}`);
      return json(res, 200, { type: "work", id: workId, state: "stopped", data: { type: "session", id: "" } });
    }
    if (req.method === "POST" && path === "/v1/agents") {
      const parsed = JSON.parse(await body(req)) as Record<string, unknown>;
      state.agentCreates.push(parsed);
      agentCount++;
      return json(res, 200, { type: "agent", id: `agent_auto_${agentCount}`, version: 1 });
    }
    if (req.method === "POST" && /^\/v1\/agents\/[^/]+\/archive$/.test(path)) return json(res, 200, {});
    if (req.method === "POST" && path === "/v1/messages") {
      const parsed = JSON.parse(await body(req)) as Record<string, unknown>;
      state.messageCreates.push(parsed);
      return json(res, 200, {
        type: "message",
        content: [{ type: "text", text: "one-shot reply" }],
        usage: { input_tokens: 12, output_tokens: 4 },
      });
    }
    if (req.method === "POST" && path === "/v1/sessions") {
      const parsed = JSON.parse(await body(req)) as Record<string, unknown>;
      state.createBodies.push(parsed);
      state.createHeaders.push({ ...req.headers });
      if (state.createStatus !== 200) return json(res, state.createStatus, { error: { message: "bad key" } });
      sessionCount++;
      return json(res, 200, { type: "session", id: `sesn_${sessionCount}`, status: "idle" });
    }
    const sessionMatch = /^\/v1\/sessions\/([^/]+)(\/.*)?$/.exec(path);
    if (!sessionMatch) return json(res, 404, { error: { message: "not found" } });
    const sessionId = sessionMatch[1]!;
    const rest = sessionMatch[2] ?? "";
    if (req.method === "GET" && rest === "")
      return json(res, 200, { type: "session", id: sessionId, status: state.status });
    if (req.method === "POST" && rest === "") {
      const parsed = JSON.parse(await body(req)) as { agent?: { tools?: unknown[] } };
      state.toolUpdates.push({ sessionId, tools: parsed.agent?.tools ?? [] });
      return json(res, 200, { type: "session", id: sessionId, status: state.status });
    }
    if (req.method === "DELETE" && rest === "") {
      state.deleted.push(sessionId);
      return json(res, 200, {});
    }
    if (req.method === "POST" && rest === "/events") {
      if (state.failEventsPosts > 0) {
        state.failEventsPosts--;
        return json(res, 500, { error: { message: "transient" } });
      }
      const parsed = JSON.parse(await body(req)) as { events: FakeEvent[] };
      state.eventPosts.push({ sessionId, events: parsed.events });
      for (const event of parsed.events) {
        if (event.type === "user.tool_result") state.sequence.push("tool_result");
      }
      for (const event of parsed.events)
        state.listedEvents.push({ ...event, id: `sevt_in_${state.listedEvents.length}` });
      if (state.failEventsPostsAfterApply > 0) {
        state.failEventsPostsAfterApply--;
        emit(onEvents(parsed.events, state));
        return json(res, 500, { error: { message: "applied but the response was lost" } });
      }
      json(res, 200, {});
      emit(onEvents(parsed.events, state));
      return;
    }
    if (req.method === "GET" && rest === "/events") return json(res, 200, { data: state.listedEvents });
    if (req.method === "GET" && rest === "/events/stream") {
      state.streams++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("\n");
      sse = res;
      req.on("close", () => {
        if (sse === res) sse = null;
      });
      return;
    }
    return json(res, 404, { error: { message: "not found" } });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({
        state,
        close: () =>
          new Promise((done) => {
            sse?.end();
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

const scope = { kind: "org", id: "test" } as unknown as ScopeId;

function cmaHarness(state: FakeCmaState, overrides: Partial<CmaHarnessOptions> = {}) {
  return createCmaHarness({
    environmentId: "env_1",
    environmentKey: "sk-ant-oat01-test",
    agentId: "agent_1",
    apiKey: "sk-test",
    baseUrl: state.url,
    turnWallClockMs: 15_000,
    ...overrides,
  });
}

function stubTools(executed: string[]): HarnessTurnInput["tools"] {
  return {
    execute: async (command: string) => {
      executed.push(command);
      return { stdout: `ran ${command}`, stderr: "", code: 0 };
    },
  } as unknown as HarnessTurnInput["tools"];
}

function turnInput(
  overrides: Partial<HarnessTurnInput> & { entries?: SessionEntry[]; executed?: string[] },
): HarnessTurnInput {
  const entries = overrides.entries ?? [];
  const session = (overrides.session ?? { id: "session-1" }) as Session;
  return {
    session,
    input: "hi",
    systemPrompt: "be concise",
    history: [],
    tools: stubTools(overrides.executed ?? []),
    scopeLabel: scope,
    orgScopeId: scope,
    emit: async (entry) => {
      const saved = { ...entry, sessionId: session.id, seq: entries.length + 1, createdAt: Date.now() } as SessionEntry;
      entries.push(saved);
      return saved;
    },
    recordModelCall: () => {},
    ...overrides,
  } as HarnessTurnInput;
}

test("CMA drives a full turn: custom tool round-trip, streamed deltas, durable session record", async (t) => {
  const fake = await startFakeCma((events) => {
    const first = events[0] as { type?: string } | undefined;
    if (first?.type === "user.message") {
      return [
        { type: "agent.custom_tool_use", id: "sevt_t1", name: "execute", input: { command: "echo hi" } },
        {
          type: "session.status_idle",
          id: "sevt_s1",
          stop_reason: { type: "requires_action", event_ids: ["sevt_t1"] },
        },
      ];
    }
    if (first?.type === "user.custom_tool_result") {
      return [
        { type: "event_start", event: { type: "agent.message", id: "sevt_m1" } },
        {
          type: "event_delta",
          event_id: "sevt_m1",
          delta: { type: "content_delta", index: 0, content: { type: "text", text: "Hel" } },
        },
        {
          type: "event_delta",
          event_id: "sevt_m1",
          delta: { type: "content_delta", index: 0, content: { type: "text", text: "lo" } },
        },
        { type: "agent.message", id: "sevt_m1", content: [{ type: "text", text: "Hello" }] },
        { type: "agent.thinking", id: "sevt_th1", thinking: "pondering" },
        {
          type: "span.model_request_end",
          id: "sevt_sp1",
          model_usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 2,
          },
        },
        { type: "session.status_idle", id: "sevt_s2", stop_reason: { type: "end_turn" } },
      ];
    }
    return [];
  });
  t.after(fake.close);
  const records = createMemoryMap<CmaSessionRecord>();
  const harness = cmaHarness(fake.state, { sessions: records });
  const entries: SessionEntry[] = [];
  const executed: string[] = [];
  const deltas: string[] = [];
  const recordedInputTokens: number[] = [];
  const result = await harness.turns.runTurn(
    turnInput({
      entries,
      executed,
      onDelta: (delta) => deltas.push(delta),
      recordModelCall: ({ inputTokens }) => recordedInputTokens.push(inputTokens),
    }),
  );

  assert.equal(result.reply, "Hello");
  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.deepEqual(recordedInputTokens, [107], "real span usage replaces the estimate: input + cache read + write");
  assert.deepEqual(result.cacheUsage, { cacheRead: 5, cacheWrite: 2, uncachedInput: 100 });
  assert.deepEqual(executed, ["echo hi"]);
  assert.deepEqual(
    entries.map((entry) => entry.type),
    ["user", "tool_call", "tool_result", "thinking", "assistant"],
  );
  assert.equal(fake.state.createBodies.length, 1);
  const created = fake.state.createBodies[0]!;
  const agent = created.agent as {
    type: string;
    id: string;
    system: string;
    model: { id: string };
    tools: Array<{ type: string; name: string }>;
  };
  assert.equal(agent.type, "agent_with_overrides");
  assert.equal(agent.id, "agent_1");
  assert.equal(agent.system, "be concise");
  assert.equal(created.environment_id, "env_1");
  assert.ok(agent.tools.some((tool) => tool.type === "custom" && tool.name === "execute"));
  assert.ok(
    !agent.tools.some((tool) => tool.type === "custom" && CMA_NATIVE_TOOL_NAMES.has(tool.name)),
    "custom tools never reuse a native toolset name — the CMA API rejects the session",
  );
  assert.equal(fake.state.createHeaders[0]!["x-api-key"], "sk-test");
  assert.equal(fake.state.createHeaders[0]!["anthropic-beta"], "managed-agents-2026-04-01");
  const toolResultPost = fake.state.eventPosts[1]!.events[0] as {
    type: string;
    custom_tool_use_id: string;
    content: Array<{ text: string }>;
  };
  assert.equal(toolResultPost.type, "user.custom_tool_result");
  assert.equal(toolResultPost.custom_tool_use_id, "sevt_t1");
  assert.match(toolResultPost.content[0]!.text, /ran echo hi/);
  const record = await records.get("session-1");
  assert.equal(record?.cmaSessionId, "sesn_1");
  assert.equal(record?.lastSeq, entries.length);
});

test("CMA resumes the mapped session across turns and rotates it when the system prompt changes", async (t) => {
  const fake = await startFakeCma((events) => {
    const first = events[0] as { type?: string } | undefined;
    if (first?.type !== "user.message") return [];
    const turn = fake.state.eventPosts.length;
    return [
      { type: "agent.message", id: `sevt_m${turn}`, content: [{ type: "text", text: `reply ${turn}` }] },
      { type: "session.status_idle", id: `sevt_s${turn}`, stop_reason: { type: "end_turn" } },
    ];
  });
  t.after(fake.close);
  const records = createMemoryMap<CmaSessionRecord>();
  const harness = cmaHarness(fake.state, { sessions: records });
  const entries: SessionEntry[] = [];
  const first = await harness.turns.runTurn(turnInput({ entries, input: "first question" }));
  assert.equal(first.reply, "reply 1");
  assert.equal(fake.state.createBodies.length, 1);

  const second = await harness.turns.runTurn(turnInput({ entries, history: [...entries], input: "second question" }));
  assert.equal(second.reply, "reply 2");
  assert.equal(fake.state.createBodies.length, 1, "an unchanged context reuses the CMA session");
  const secondMessage = fake.state.eventPosts.at(-1)!.events[0] as { content: Array<{ type: string; text?: string }> };
  assert.doesNotMatch(secondMessage.content[0]!.text!, /BEGIN TRANSCRIPT/);
  assert.match(secondMessage.content[0]!.text!, /second question/);

  const third = await harness.turns.runTurn(
    turnInput({ entries, history: [...entries], input: "third question", systemPrompt: "be thorough" }),
  );
  assert.equal(third.reply, "reply 3");
  assert.equal(fake.state.createBodies.length, 2, "a changed system prompt rotates to a fresh CMA session");
  const thirdMessage = fake.state.eventPosts.at(-1)!.events[0] as { content: Array<{ type: string; text?: string }> };
  assert.match(thirdMessage.content[0]!.text!, /BEGIN TRANSCRIPT/);
  assert.match(thirdMessage.content[0]!.text!, /first question/);
  assert.equal((await records.get("session-1"))?.cmaSessionId, "sesn_2");
});

test("CMA strict posture holds the tool call for approval and interrupts the session", async (t) => {
  const fake = await startFakeCma((events) => {
    const first = events[0] as { type?: string } | undefined;
    if (first?.type === "user.message") {
      return [
        { type: "agent.custom_tool_use", id: "sevt_t1", name: "execute", input: { command: "rm -rf /" } },
        {
          type: "session.status_idle",
          id: "sevt_s1",
          stop_reason: { type: "requires_action", event_ids: ["sevt_t1"] },
        },
      ];
    }
    return [];
  });
  t.after(fake.close);
  const harness = cmaHarness(fake.state);
  const entries: SessionEntry[] = [];
  const executed: string[] = [];
  const result = await harness.turns.runTurn(turnInput({ entries, executed, toolApprovalGate: () => false }));

  assert.equal(result.pausedOnApproval, true);
  assert.equal(result.reply, "");
  assert.equal(result.pendingApprovals?.[0]?.command, "execute");
  assert.deepEqual(executed, [], "the gated tool never reaches the sandbox");
  const posted = fake.state.eventPosts.map((post) => post.events.map((event) => event.type as string)).flat();
  assert.deepEqual(posted, ["user.message", "user.custom_tool_result", "user.interrupt"]);
  const blocked = fake.state.eventPosts[1]!.events[0] as { content: Array<{ text: string }> };
  assert.match(blocked.content[0]!.text, /needs human approval/);
});

test("CMA classifies terminal API errors as non-retryable and clears a dead session mapping", async (t) => {
  const fake = await startFakeCma(() => [{ type: "session.status_terminated", id: "sevt_dead" }]);
  t.after(fake.close);
  const records = createMemoryMap<CmaSessionRecord>();
  const harness = cmaHarness(fake.state, { sessions: records });
  await assert.rejects(
    harness.turns.runTurn(turnInput({})),
    (error: Error) => !(error instanceof NonRetryableTurnError) && /terminated/.test(error.message),
  );
  assert.equal(await records.get("session-1"), null);

  fake.state.createStatus = 401;
  await assert.rejects(harness.turns.runTurn(turnInput({})), NonRetryableTurnError);

  const unconfigured = createCmaHarness();
  await assert.rejects(unconfigured.turns.runTurn(turnInput({})), /CMA harness is not configured/);
});

test("CMA surfaces a retries_exhausted stop as a turn error instead of a silent empty reply", async (t) => {
  const fake = await startFakeCma((events) => {
    const first = events[0] as { type?: string } | undefined;
    if (first?.type !== "user.message") return [];
    return [{ type: "session.status_idle", id: "sevt_s1", stop_reason: { type: "retries_exhausted" } }];
  });
  t.after(fake.close);
  const harness = cmaHarness(fake.state);
  await assert.rejects(
    harness.turns.runTurn(turnInput({})),
    (error: Error) => !(error instanceof NonRetryableTurnError) && /retries/.test(error.message),
  );
});

test("CMA polling delivery completes a turn without an event stream", async (t) => {
  const fake = await startFakeCma((events) => {
    const first = events[0] as { type?: string } | undefined;
    if (first?.type !== "user.message") return [];
    return [
      { type: "agent.message", id: "sevt_m1", content: [{ type: "text", text: "polled reply" }] },
      { type: "session.status_idle", id: "sevt_s1", stop_reason: { type: "end_turn" } },
    ];
  });
  t.after(fake.close);
  const harness = cmaHarness(fake.state, { delivery: "poll", pollIntervalMs: 20 });
  const result = await harness.turns.runTurn(turnInput({}));
  assert.equal(result.reply, "polled reply");
  assert.equal(fake.state.streams, 0);
});

test("CMA one-shots go straight to the Messages API with real usage reported", async (t) => {
  const fake = await startFakeCma(() => []);
  t.after(fake.close);
  const records = createMemoryMap<CmaSessionRecord>();
  const harness = cmaHarness(fake.state, { sessions: records });
  assert.equal(await harness.models.oneShot?.("system", "question"), "one-shot reply");
  assert.equal(fake.state.messageCreates.length, 1);
  assert.equal(fake.state.messageCreates[0]!.system, "system");
  assert.equal(fake.state.createBodies.length, 0, "no CMA session is created for a one-shot");
  assert.deepEqual(await records.entries(), []);
  const calls: number[] = [];
  await harness.models.judge?.("system", "verdict please");
  assert.equal(fake.state.messageCreates[1]!.model, "claude-haiku-4-5");
  const detect = await harness.models.shouldRespond?.({
    session: { id: "s" },
    message: "hello",
    recentContext: "",
    systemPrompt: "",
    history: [],
    recordModelCall: ({ inputTokens }: { inputTokens: number }) => calls.push(inputTokens),
  } as never);
  assert.equal(typeof detect?.respond, "boolean");
  assert.deepEqual(calls, [12], "detect records the Messages API's real input token count");
});

test("CMA provisions one agent per model and effort and reuses it", async (t) => {
  const fake = await startFakeCma((events) => {
    const first = events[0] as { type?: string } | undefined;
    if (first?.type !== "user.message") return [];
    return [
      { type: "agent.message", id: `sevt_m${fake.state.eventPosts.length}`, content: [{ type: "text", text: "ok" }] },
      { type: "session.status_idle", id: `sevt_s${fake.state.eventPosts.length}`, stop_reason: { type: "end_turn" } },
    ];
  });
  t.after(fake.close);
  const harness = createCmaHarness({
    orgId: "acme",
    environmentId: "env_1",
    environmentKey: "sk-ant-oat01-test",
    apiKey: "sk-test",
    baseUrl: fake.state.url,
    turnWallClockMs: 15_000,
  });
  const entries: SessionEntry[] = [];
  await harness.turns.runTurn(turnInput({ entries, thinkingLevel: "high" }));
  assert.equal(fake.state.agentCreates.length, 1);
  assert.equal(fake.state.agentCreates[0]!.name, "qm acme claude-opus-5 high");
  assert.deepEqual(fake.state.agentCreates[0]!.model, { id: "claude-opus-5", effort: "high" });
  const sessionAgent = fake.state.createBodies[0]!.agent as { id: string; model?: unknown };
  assert.equal(sessionAgent.id, "agent_auto_1");
  assert.equal(sessionAgent.model, undefined, "the tuple agent carries the model, so the session does not override it");

  await harness.turns.runTurn(turnInput({ entries, history: [...entries], input: "again", thinkingLevel: "high" }));
  assert.equal(fake.state.agentCreates.length, 1, "the tuple agent is reused");
  assert.equal(fake.state.createBodies.length, 1, "and so is the CMA session");

  await harness.turns.runTurn(turnInput({ entries, history: [...entries], input: "more", thinkingLevel: "low" }));
  assert.equal(fake.state.agentCreates.length, 2, "a different effort provisions its own agent");
  assert.deepEqual(fake.state.agentCreates[1]!.model, { id: "claude-opus-5", effort: "low" });
  assert.equal(fake.state.createBodies.length, 2, "and rotates the session to it");
});

test("CMA keys session reuse on the stable system prefix so per-turn context does not rotate it", async (t) => {
  const fake = await startFakeCma((events) => {
    const first = events[0] as { type?: string } | undefined;
    if (first?.type !== "user.message") return [];
    return [
      { type: "agent.message", id: `sevt_m${fake.state.eventPosts.length}`, content: [{ type: "text", text: "ok" }] },
      { type: "session.status_idle", id: `sevt_s${fake.state.eventPosts.length}`, stop_reason: { type: "end_turn" } },
    ];
  });
  t.after(fake.close);
  const harness = cmaHarness(fake.state);
  const stable = "You are the org agent.";
  const entries: SessionEntry[] = [];
  await harness.turns.runTurn(
    turnInput({
      entries,
      systemPrompt: `${stable}\n\n## Current time\n2026-08-01T10:00:00Z`,
      systemCacheBoundary: stable.length,
    }),
  );
  await harness.turns.runTurn(
    turnInput({
      entries,
      history: [...entries],
      input: "next",
      systemPrompt: `${stable}\n\n## Current time\n2026-08-01T10:05:00Z`,
      systemCacheBoundary: stable.length,
    }),
  );
  assert.equal(fake.state.createBodies.length, 1, "a volatile suffix does not rotate the session");
  assert.equal((fake.state.createBodies[0]!.agent as { system: string }).system, stable);
  const firstMessage = fake.state.eventPosts[0]!.events[0] as { content: Array<{ text?: string }> };
  assert.match(firstMessage.content[0]!.text!, /Current time/);
  await harness.turns.runTurn(
    turnInput({ entries, history: [...entries], input: "changed", systemPrompt: "A different soul entirely." }),
  );
  assert.equal(fake.state.createBodies.length, 2, "a stable-prefix change still rotates");
});

test("CMA retries a transiently failing initial send instead of hanging", async (t) => {
  const fake = await startFakeCma((events) => {
    const first = events[0] as { type?: string } | undefined;
    if (first?.type !== "user.message") return [];
    return [
      { type: "agent.message", id: "sevt_m1", content: [{ type: "text", text: "made it" }] },
      { type: "session.status_idle", id: "sevt_s1", stop_reason: { type: "end_turn" } },
    ];
  });
  t.after(fake.close);
  fake.state.failEventsPosts = 1;
  const harness = cmaHarness(fake.state);
  const result = await harness.turns.runTurn(turnInput({}));
  assert.equal(result.reply, "made it");
  assert.equal(fake.state.eventPosts.length, 1);
});

test("CMA does not duplicate the user message when a send is applied but the response is lost", async (t) => {
  const fake = await startFakeCma((events) => {
    const first = events[0] as { type?: string } | undefined;
    if (first?.type !== "user.message") return [];
    return [
      { type: "agent.message", id: "sevt_m1", content: [{ type: "text", text: "made it" }] },
      { type: "session.status_idle", id: "sevt_s1", stop_reason: { type: "end_turn" } },
    ];
  });
  t.after(fake.close);
  fake.state.failEventsPostsAfterApply = 1;
  const result = await cmaHarness(fake.state).turns.runTurn(turnInput({}));
  assert.equal(result.reply, "made it");
  const userPosts = fake.state.eventPosts.filter(
    (post) => (post.events[0] as { type?: string }).type === "user.message",
  );
  assert.equal(userPosts.length, 1, "the applied-but-failed send is detected and not re-posted");
});

test("CMA retries a transiently failing tool-result post instead of failing the turn", async (t) => {
  const fake = await startFakeCma((events, state) => {
    const first = events[0] as { type?: string } | undefined;
    if (first?.type === "user.message") {
      state.failEventsPosts = 1;
      return [
        { type: "agent.custom_tool_use", id: "sevt_t1", name: "execute", input: { command: "echo once" } },
        {
          type: "session.status_idle",
          id: "sevt_s1",
          stop_reason: { type: "requires_action", event_ids: ["sevt_t1"] },
        },
      ];
    }
    if (first?.type === "user.custom_tool_result") {
      return [
        { type: "agent.message", id: "sevt_m1", content: [{ type: "text", text: "done" }] },
        { type: "session.status_idle", id: "sevt_s2", stop_reason: { type: "end_turn" } },
      ];
    }
    return [];
  });
  t.after(fake.close);
  const harness = cmaHarness(fake.state);
  const executed: string[] = [];
  const result = await harness.turns.runTurn(turnInput({ executed }));
  assert.equal(result.reply, "done");
  assert.deepEqual(executed, ["echo once"], "the tool ran exactly once despite the failed result post");
});

test("CMA re-sends a failed steer even when its text matches the original message", async (t) => {
  const signals = createMemoryRunSignalStore();
  let userPosts = 0;
  const fake = await startFakeCma((events, state) => {
    const first = events[0] as { type?: string } | undefined;
    if (first?.type !== "user.message") return [];
    userPosts++;
    if (userPosts === 1) {
      void signals.send("run-1", { kind: "steer", text: "hi" });
      state.failEventsPosts = 1;
      state.emitLater!([{ type: "session.status_idle", id: "sevt_s1", stop_reason: { type: "end_turn" } }], 400);
      return [];
    }
    return [
      { type: "agent.message", id: "sevt_m1", content: [{ type: "text", text: "steered reply" }] },
      { type: "session.status_idle", id: "sevt_s2", stop_reason: { type: "end_turn" } },
    ];
  });
  t.after(fake.close);
  const harness = cmaHarness(fake.state, { signals });
  const result = await harness.turns.runTurn(turnInput({ runId: "run-1" }));
  assert.equal(result.reply, "steered reply");
  assert.equal(userPosts, 2, "the failed steer send is retried, not deduped against the original message's echo");
});

test("CMA rotates the session when the environment changes", async (t) => {
  const fake = await startFakeCma((events) => {
    const first = events[0] as { type?: string } | undefined;
    if (first?.type !== "user.message") return [];
    return [
      { type: "agent.message", id: `sevt_m${fake.state.eventPosts.length}`, content: [{ type: "text", text: "ok" }] },
      { type: "session.status_idle", id: `sevt_s${fake.state.eventPosts.length}`, stop_reason: { type: "end_turn" } },
    ];
  });
  t.after(fake.close);
  const records = createMemoryMap<CmaSessionRecord>();
  const entries: SessionEntry[] = [];
  await cmaHarness(fake.state, { sessions: records }).turns.runTurn(turnInput({ entries }));
  assert.equal(fake.state.createBodies.length, 1);

  const moved = cmaHarness(fake.state, { environmentId: "env_2", sessions: records });
  await moved.turns.runTurn(turnInput({ entries, history: [...entries], input: "again" }));
  assert.equal(fake.state.createBodies.length, 2, "a new environment provisions a fresh CMA session");
  assert.equal(fake.state.createBodies[1]!.environment_id, "env_2");
  assert.deepEqual(fake.state.deleted, ["sesn_1"], "the old environment's session is deleted");
});

test("CMA abort mid-generation keeps the text already streamed", async (t) => {
  const fake = await startFakeCma((events) => {
    const first = events[0] as { type?: string } | undefined;
    if (first?.type !== "user.message") return [];
    return [
      { type: "event_start", event: { type: "agent.message", id: "sevt_m1" } },
      {
        type: "event_delta",
        event_id: "sevt_m1",
        delta: { type: "content_delta", index: 0, content: { type: "text", text: "partial answer" } },
      },
    ];
  });
  t.after(fake.close);
  const harness = cmaHarness(fake.state);
  const cancel = new AbortController();
  const deltas: string[] = [];
  const entries: SessionEntry[] = [];
  const turn = harness.turns.runTurn(
    turnInput({ entries, cancel: cancel.signal, onDelta: (delta) => deltas.push(delta) }),
  );
  await settle(async () => deltas.length > 0);
  cancel.abort();
  const result = await turn;
  assert.equal(result.stopped, true);
  assert.equal(result.reply, "partial answer");
  assert.equal(entries.at(-1)?.type, "assistant");
  const posted = fake.state.eventPosts.flatMap((post) => post.events.map((event) => event.type as string));
  assert.deepEqual(posted, ["user.message", "user.interrupt"]);
});

test("CMA cancellation before any network call returns a quiet stop", async () => {
  const harness = createCmaHarness({ environmentId: "env_1", agentId: "agent_1", apiKey: "sk-test" });
  const cancel = new AbortController();
  cancel.abort();
  assert.deepEqual(await harness.turns.runTurn(turnInput({ cancel: cancel.signal })), { reply: "", stopped: true });
});

test("CMA custom tool declarations carry each bridged tool's schema", () => {
  const tools = cmaCustomTools([
    { name: "execute", description: "run a command", parameters: { type: "object" }, execute: async () => ({}) },
  ]);
  assert.deepEqual(tools, [
    { type: "custom", name: "execute", description: "run a command", input_schema: { type: "object" } },
  ]);
  assert.equal(cmaContextKey("system", "claude-opus-5"), cmaContextKey("system", "claude-opus-5"));
  assert.notEqual(cmaContextKey("system", "claude-opus-5"), cmaContextKey("other", "claude-opus-5"));
});

test("CMA custom tools that collide with native toolset names get the qm_ namespace", () => {
  const bridged = (name: string) => ({
    name,
    description: `${name} tool`,
    parameters: { type: "object" },
    execute: async () => ({}),
  });
  const tools = cmaCustomTools([bridged("read"), bridged("write"), bridged("memory")]);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["qm_read", "qm_write", "memory"],
  );
});

test("CMA config options map every knob the adapter consumes", () => {
  const config = {
    orgId: "acme",
    cmaModel: "claude-sonnet-5",
    judgeModelId: "claude-haiku-4-5",
    cmaEnvironmentId: "env_9",
    cmaEnvironmentKey: "sk-ant-oat01-9",
    cmaAgentId: "agent_9",
    anthropicApiKey: "sk-ant",
    cmaBaseUrl: "https://cma.example",
    cmaDelivery: "poll",
    turnWallClockMs: 120_000,
    execTimeoutDefaultMs: 60_000,
    execTimeoutMaxMs: 600_000,
    backgroundJobTtlMs: 60_000,
    backgroundJobTtlMaxMs: 600_000,
    scratchExecEnabled: true,
    sharedOwnerAuthIsolation: false,
    reachExecEnabled: false,
    signingSecret: "secret",
    apiBaseUrl: "https://core.example",
  } as unknown as Config;
  const options = cmaHarnessConfigOptions(config);
  assert.equal(options.orgId, "acme");
  assert.equal(options.defaultModelId, "claude-sonnet-5");
  assert.equal(options.judgeModelId, "claude-haiku-4-5");
  assert.equal(options.environmentId, "env_9");
  assert.equal(options.environmentKey, "sk-ant-oat01-9");
  assert.equal(options.agentId, "agent_9");
  assert.equal(options.apiKey, "sk-ant");
  assert.equal(options.baseUrl, "https://cma.example");
  assert.equal(options.delivery, "poll");
  assert.equal(options.turnWallClockMs, 120_000);
  assert.equal(options.scratchExec, true);
  assert.equal(options.controlTools, true);
});

function nativeBashScenario(finishDelayMs: number) {
  return (events: FakeEvent[], state: FakeCmaState): FakeEvent[] => {
    const first = events[0] as { type?: string } | undefined;
    if (first?.type === "user.message") {
      state.workQueue.push({ id: "work_1", sessionId: "sesn_1" });
      return [
        { type: "agent.tool_use", id: "sevt_b1", name: "bash", input: { command: "uname -a", timeout: 120000 } },
        {
          type: "session.status_idle",
          id: "sevt_s1",
          stop_reason: { type: "requires_action", event_ids: ["sevt_b1"] },
        },
      ];
    }
    if (first?.type === "user.tool_result") {
      state.emitLater!(
        [
          { type: "agent.message", id: "sevt_m1", content: [{ type: "text", text: "ran it" }] },
          { type: "session.status_idle", id: "sevt_s2", stop_reason: { type: "end_turn" } },
        ],
        finishDelayMs,
      );
      return [];
    }
    return [];
  };
}

test("CMA runs native bash through the shared execute tool and holds the work lease for the turn", async (t) => {
  const fake = await startFakeCma(nativeBashScenario(500));
  t.after(fake.close);
  const harness = cmaHarness(fake.state);
  t.after(async () => harness.turns.close?.());
  const executed: string[] = [];
  const result = await harness.turns.runTurn(turnInput({ executed }));

  assert.equal(result.reply, "ran it");
  assert.deepEqual(executed, ["uname -a"], "the native bash call executes through the bridged execute tool");
  const tools = (
    fake.state.createBodies[0]!.agent as {
      tools: Array<{ type: string; configs?: Array<{ name: string; enabled: boolean }> }>;
    }
  ).tools;
  assert.equal(tools[0]!.type, "agent_toolset_20260401");
  assert.deepEqual(tools[0]!.configs?.[0], { name: "bash", enabled: true });
  assert.ok(tools[0]!.configs!.slice(1).every((config) => config.enabled === false));
  assert.ok(tools.some((tool) => tool.type === "custom"));
  const resultPost = fake.state.eventPosts[1]!.events[0] as { type: string; tool_use_id: string };
  assert.equal(resultPost.type, "user.tool_result");
  assert.equal(resultPost.tool_use_id, "sevt_b1");

  assert.deepEqual(fake.state.workAcked, ["work_1"], "the attendant claims the turn's work item");
  assert.deepEqual(fake.state.workStopped, ["work_1"], "and stops it when the turn completes");
  assert.ok(fake.state.sequence.includes("tool_result"));
  assert.equal(fake.state.sequence.at(-1), "stop:work_1", "the lease is released only after the turn ends");
  assert.ok(fake.state.workHeartbeats >= 1);
  assert.equal(fake.state.workAuth[0], "Bearer sk-ant-oat01-test");
});

test("CMA strict posture gates native bash exactly like custom tools", async (t) => {
  const fake = await startFakeCma(nativeBashScenario(100));
  t.after(fake.close);
  const harness = cmaHarness(fake.state);
  t.after(async () => harness.turns.close?.());
  const executed: string[] = [];
  const result = await harness.turns.runTurn(turnInput({ executed, toolApprovalGate: () => false }));

  assert.equal(result.pausedOnApproval, true);
  assert.equal(result.pendingApprovals?.[0]?.command, "execute");
  assert.deepEqual(executed, [], "the gated command never executes");
  const resultPost = fake.state.eventPosts[1]!.events[0] as { type: string; content: Array<{ text: string }> };
  assert.equal(resultPost.type, "user.tool_result");
  assert.match(resultPost.content[0]!.text, /blocked: needs human approval/);
  const posted = fake.state.eventPosts.flatMap((post) => post.events.map((event) => event.type as string));
  assert.deepEqual(posted, ["user.message", "user.tool_result", "user.interrupt"]);
});

test("CMA resetSession deletes the mapped server-side session, not just the local record", async (t) => {
  const fake = await startFakeCma((events) => {
    const first = events[0] as { type?: string } | undefined;
    if (first?.type !== "user.message") return [];
    return [
      { type: "agent.message", id: "sevt_m1", content: [{ type: "text", text: "ok" }] },
      { type: "session.status_idle", id: "sevt_s1", stop_reason: { type: "end_turn" } },
    ];
  });
  t.after(fake.close);
  const records = createMemoryMap<CmaSessionRecord>();
  const harness = cmaHarness(fake.state, { sessions: records });
  await harness.turns.runTurn(turnInput({}));
  assert.equal((await records.get("session-1"))?.cmaSessionId, "sesn_1");

  await harness.turns.resetSession?.("session-1");
  assert.equal(await records.get("session-1"), null);
  assert.deepEqual(fake.state.deleted, ["sesn_1"], "the server-side transcript is deleted with the mapping");

  await records.put("session-2", {
    cmaSessionId: "sesn_orphan",
    contextKey: "k",
    toolsKey: "t",
    lastSeq: 0,
    updatedAt: Date.now(),
  });
  const fresh = cmaHarness(fake.state, { sessions: records });
  await fresh.turns.resetSession?.("session-2");
  assert.deepEqual(
    fake.state.deleted,
    ["sesn_1", "sesn_orphan"],
    "a reset on a fresh instance still deletes the mapped server-side session",
  );
});

test("the work attendant leaves work for sessions it is not running unclaimed", async (t) => {
  const fake = await startFakeCma(nativeBashScenario(1_800));
  t.after(fake.close);
  fake.state.workQueue.push({ id: "work_ghost", sessionId: "sesn_ghost" });
  const harness = cmaHarness(fake.state);
  t.after(async () => harness.turns.close?.());
  await harness.turns.runTurn(turnInput({}));

  assert.deepEqual(fake.state.workAcked, ["work_1"], "only the running turn's work is claimed");
  assert.ok(!fake.state.workStopped.includes("work_ghost"));
});
