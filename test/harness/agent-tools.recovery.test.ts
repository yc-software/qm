import { test } from "node:test";
import { createGoalRecord } from "../../src/harness/goal.ts";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { createAgentTools } from "../../src/harness/agent-tools.ts";
import { createTurnToolState, type TurnToolState, type TurnToolStateInit } from "../../src/harness/turn-tool-state.ts";
import { resumeStrategy } from "../../src/core/turn-resume.ts";
import { CommandDenied } from "../../src/tools/primitives.ts";
import { itemFields, storedItem, type Item } from "../../src/sessions/items.ts";
import {
  fakeToolContext,
  type Emitted,
  emittedItem,
  call,
  callWith,
  textOut,
  clientTool,
  clientToolRef,
} from "../support/agent-tools.ts";

test("context recovery drains in-flight effects, preserves an active goal, and blocks subsequent calls", async () => {
  const gate = Promise.withResolvers<void>();
  const events: Emitted[] = [];
  let effects = 0;
  const ref: TurnToolStateInit = {
    current: {
      ...fakeToolContext(),
      execute: async () => {
        effects++;
        await gate.promise;
        return { stdout: "done", stderr: "", code: 0, timedOut: false };
      },
    },
    scopeLabel: "personal:U1",
    goal: createGoalRecord({ objective: "finish verification" }),
    emit: async (entry) => {
      events.push(emittedItem(entry));
    },
  };
  const state = createTurnToolState(ref);
  const goal = structuredClone(state.goal.current());
  const tools = createAgentTools(state);
  const first = call(
    tools.find((t) => t.name === "execute"),
    { command: "echo done", purpose: "Test effect" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const recovery = call(
    tools.find((t) => t.name === "context"),
    { action: "compact", mode: "recent" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    events.some((e) => e.fields.tool === "context"),
    false,
  );
  await call(
    tools.find((t) => t.name === "execute"),
    { command: "echo duplicate", purpose: "Test barrier" },
  );
  assert.equal(effects, 1);
  gate.resolve();
  await first;
  assert.equal(((await recovery) as { terminate: boolean }).terminate, true);
  assert.deepEqual(state.halt.handoff(), { context: "recent" });
  assert.deepEqual(state.goal.current(), goal);
  assert.equal(events.at(-1)!.fields.tool, "context");
  assert.equal(events.filter((e) => e.kind === "ToolResult" && e.fields.tool === "execute").length, 1);
});

for (const cancel of [false, true]) {
  test(`context recovery cannot latch after ${cancel ? "cancellation" : "persistence failure"}`, async () => {
    const gate = Promise.withResolvers<void>();
    const abort = new AbortController();
    const ref: TurnToolStateInit = {
      current: fakeToolContext(),
      scopeLabel: "personal:U1",
      abortSignal: abort.signal,
      emit: async (entry) => {
        if (!cancel && entry.kind === "ToolResult") throw new Error("write failed");
      },
    };
    const state = createTurnToolState(ref);
    const tool = createAgentTools(state).find((t) => t.name === "context");
    const recovery = call(tool, { action: "compact", mode: "recent" });
    if (cancel) abort.abort();
    gate.resolve();
    if (cancel) await recovery;
    else await assert.rejects(recovery, /write failed/);
    assert.equal(state.halt.handoff(), undefined);
    assert.equal(state.tools.runtimeMutationPending(), false);
  });
}

test("context recovery is not available in read-only mode", () => {
  assert.ok(
    !createAgentTools(createTurnToolState({ current: fakeToolContext() }), { readOnly: true }).some(
      (t) => t.name === "context",
    ),
  );
});

test("command exit codes are data; timeouts and thrown tool errors are failures", async () => {
  {
    for (const outcome of ["zero", "nonzero", "timeout", "provider", "denied"] as const) {
      const entries: Emitted[] = [];
      const tool = createAgentTools(
        createTurnToolState({
          current: {
            ...fakeToolContext(),
            execute: async () => {
              if (outcome === "provider") throw new Error("sandbox provider unavailable");
              if (outcome === "denied") throw new CommandDenied("[ -d dir ]", "policy denied");
              return { stdout: "", stderr: "", code: outcome === "zero" ? 0 : 1, timedOut: outcome === "timeout" };
            },
          },
          scopeLabel: "personal:U1",
          emit: (entry) => {
            entries.push(emittedItem(entry));
          },
        }),
      ).find((t) => t.name === "execute")!;
      const run = () =>
        call(tool, {
          command: "[ -d dir ]",
          purpose: "Check directory",
        });
      if (outcome === "provider") {
        await assert.rejects(run, /sandbox provider unavailable/);
        const result = entries.find((e) => e.kind === "ToolResult")!.fields;
        assert.equal(result.isError, true);
        assert.equal(result.text, "Command execution failed: sandbox provider unavailable");
        assert.equal(result.code, undefined);
        continue;
      }
      const returned = await run();
      const result = entries.find((e) => e.kind === "ToolResult")!.fields;
      assert.equal(result.isError, !["zero", "nonzero"].includes(outcome), outcome);
      if (outcome === "nonzero") {
        assert.equal(result.code, 1);
        assert.match(textOut(returned), /\[exit 1\]/);
      }
    }
  }
});

test("thrown execution errors leave pending child messages for the next delivered result", async () => {
  {
    let pending = true;
    const context = fakeToolContext();
    context.execute = async () => {
      throw new Error("provider unavailable");
    };
    context.sessionSyscalls = {
      open: async () => ({ ok: false, message: "unused" }),
      write: async () => ({ ok: false, message: "unused" }),
      read: async () => ({ ok: false, message: "unused" }),
      receive: async () =>
        pending
          ? [
              {
                id: "mail",
                senderId: "child",
                recipientId: "parent",
                actor: { id: "U1", type: "internal" as const },
                audience: [],
                text: "Important child finding",
                createdAt: 1,
              },
            ]
          : [],
      acknowledge: async () => {
        pending = false;
      },
    };
    const tools = createAgentTools(createTurnToolState({ current: context }));
    const tool = tools.find((t) => t.name === "execute")!;
    const input = { command: "true", purpose: "Check provider" };
    await assert.rejects(() => call(tool, input), /provider unavailable/);
    assert.equal(pending, true);
    context.execute = async () => ({ stdout: "ok", stderr: "", code: 0, timedOut: false });
    assert.match(JSON.stringify(await call(tool, input)), /Important child finding/);
    assert.equal(pending, false);
  }
});

test("subagents and sessions are separate tools with one noun each", async () => {
  const writes: Array<{ followup?: boolean; target: string; text?: string }> = [];
  const starts: Array<{ fork: boolean; text?: string; title?: string }> = [];
  const tc = fakeToolContext();
  tc.sessionSyscalls = {
    open: async () => ({ ok: false, message: "unused" }),
    write: async (input) => {
      writes.push(input);
      return { ok: true, sessionId: "peer", title: "peer", delivered: "queued_message" };
    },
    read: async () => ({ ok: true, mode: "children", children: [] }),
    list: async () => ({
      ok: true,
      sessions: [{ sessionId: "peer", title: "peer", status: "idle", current: false }],
    }),
    start: async (input) => {
      starts.push(input);
      return { ok: true, sessionId: "made", title: "made" };
    },
  };
  const tools = createAgentTools(createTurnToolState({ current: tc }), { surfaceName: "web" });
  const subagents = tools.find((tool) => tool.name === "subagents")!;
  const sessions = tools.find((tool) => tool.name === "sessions")!;
  for (const action of ["open", "followup_task", "wait"])
    assert.ok(!Check(sessions.parameters, { action }), `sessions has no ${action}`);
  for (const action of ["list", "new", "fork"])
    assert.ok(!Check(subagents.parameters, { action }), `subagents has no ${action}`);
  assert.match(textOut(await call(sessions, { action: "list" })), /peer \(peer\) — idle/);
  assert.match(textOut(await call(sessions, { action: "new", text: "hi", title: "t" })), /Started session "made"/);
  assert.match(textOut(await call(sessions, { action: "fork" })), /Forked this conversation into session "made"/);
  assert.match(textOut(await call(sessions, { action: "send_message", target: "peer", text: "fyi" })), /queued/);
  assert.match(textOut(await call(sessions, { action: "read" })), /requires `target`/);
  assert.deepEqual(starts, [{ fork: false, text: "hi", title: "t" }, { fork: true }]);
  assert.deepEqual(
    writes.map(({ followup, target, text }) => ({ followup, target, text })),
    [{ followup: undefined, target: "peer", text: "fyi" }],
  );
});

test("sessions is a web UI tool: Slack turns get subagents only", () => {
  const slack = createAgentTools(createTurnToolState({ current: fakeToolContext() }), { surfaceName: "slack" });
  assert.ok(slack.some((tool) => tool.name === "subagents"));
  assert.ok(!slack.some((tool) => tool.name === "sessions"));
  assert.doesNotMatch(slack.find((tool) => tool.name === "subagents")!.description, /use sessions/);
  assert.ok(
    !createAgentTools(createTurnToolState({ current: fakeToolContext() })).some((tool) => tool.name === "sessions"),
  );
});

test("core tools carry retrySafe while client tools cannot advertise automatic replay", async () => {
  const emitted: Emitted[] = [];
  const ref: TurnToolStateInit = {
    current: fakeToolContext(),
    emit: (e) => {
      emitted.push(emittedItem(e));
    },
    scopeLabel: "personal:U1",
  };
  const tools = createAgentTools(createTurnToolState(ref), {
    controlTools: true,
    clientTools: [
      { name: "page_state", description: "Read page state", inputSchema: { type: "object", properties: {} } },
    ],
  });
  for (const tool of tools) {
    const schema = tool.parameters as { properties?: Record<string, { type?: string }>; required?: string[] };
    assert.equal(
      schema.properties?.retrySafe?.type,
      tool.name === "page_state" ? undefined : "boolean",
      `${tool.name} retry policy`,
    );
    assert.ok(!schema.required?.includes("retrySafe"), `${tool.name} keeps retrySafe optional`);
  }
  const history = tools.find((t) => t.name === "history")!;
  assert.ok(Check(history.parameters, { query: "budget", retrySafe: true }));

  await callWith(history, "safe", { query: "budget", retrySafe: true });
  await callWith(history, "unsafe", { seq: 3, retrySafe: false });
  await callWith(history, "unmarked", { seq: 3 });

  const calls = emitted.filter((e) => e.kind === "ToolCall");
  assert.deepEqual(
    calls.map((e) => e.fields),
    [
      {
        tool: "history",
        query: "budget",
        callId: "safe",
        retrySafe: true,
        rerun: { tool: "history", input: { query: "budget" } },
      },
      { tool: "history", seq: 3, callId: "unsafe", retrySafe: false },
      { tool: "history", seq: 3, callId: "unmarked" },
    ],
  );
  assert.equal(emitted.filter((e) => e.kind === "ToolResult").length, 3);
  assert.doesNotMatch(
    JSON.stringify(emitted.filter((e) => e.kind === "ToolResult")),
    /retrySafe/,
    "the flag never reaches the tool body or its result",
  );
});

test("a tool result produced after shutdown is marked interrupted; user Stop and plain completion record it", async () => {
  const record = async (abort: "shutdown" | "stop" | "none", retrySafe = true) => {
    const emitted: Emitted[] = [];
    const shutdown = new AbortController();
    const cancel = new AbortController();
    const ref: TurnToolStateInit = {
      current: fakeToolContext(),
      emit: (e) => {
        emitted.push(emittedItem(e));
      },
      scopeLabel: "personal:U1",
      shutdown: shutdown.signal,
      abortSignal: cancel.signal,
    };
    const history = createAgentTools(createTurnToolState(ref)).find((t) => t.name === "history")!;
    if (abort === "shutdown") shutdown.abort();
    if (abort !== "none") cancel.abort();
    await callWith(history, `call-${abort}`, { query: "budget", retrySafe });
    return emitted;
  };
  const strategy = (emitted: Emitted[]) => {
    const entries = emitted.map((e, i) => storedItem(e, { sessionId: "s", seq: i + 2, createdAt: i + 2 }));
    return resumeStrategy(entries, { userSeq: 1, workEntries: entries.length });
  };

  const interrupted = await record("shutdown");
  assert.equal(interrupted.find((e) => e.kind === "ToolResult")?.fields.interrupted, true);
  assert.deepEqual(interrupted.find((e) => e.kind === "ToolResult")?.fields.stop, { kind: "shutdown" });
  assert.deepEqual(strategy(interrupted), {
    kind: "retry",
    call: { callId: "call-shutdown", tool: "history", input: { query: "budget" } },
  });
  assert.deepEqual(
    strategy(await record("shutdown", false)),
    { kind: "continue" },
    "a killed call the model marked unsafe is not re-run; its replayed result says what happened",
  );

  for (const abort of ["stop", "none"] as const) {
    const emitted = await record(abort);
    const payload = emitted.find((e) => e.kind === "ToolResult")!.fields;
    assert.ok(!("interrupted" in payload), `${abort}: an ordinary result stays a real answer`);
    assert.equal(payload.stopped === true, abort === "stop", `${abort}: only a Stop marks the result as cut off`);
    assert.deepEqual(strategy(emitted), { kind: "continue" });
  }
});

test("background starts require a nonblank purpose as a repairable tool result", async () => {
  let started = false;
  const current = {
    ...fakeToolContext(),
    async backgroundStart() {
      started = true;
      throw new Error("must not start");
    },
  };
  for (const [name, action, options] of [
    ["execute", true, {}],
    ["execute", true, {}],
  ] as const) {
    const events: Array<Record<string, unknown>> = [];
    const tool = createAgentTools(
      createTurnToolState({
        current,
        scopeLabel: "personal:U1",
        emit: (entry) => {
          events.push(itemFields(entry as Item));
        },
      }),
      options,
    ).find((t) => t.name === name)!;
    for (const purpose of [undefined, "", " \n "]) {
      const result = await call(tool, {
        background: action,
        command: "node server.js",
        ...(purpose === undefined ? {} : { purpose }),
      });
      assert.match(textOut(result), /requires.*purpose|invalid execute arguments/);
      assert.equal(events.at(-1)?.isError, true);
    }
  }
  assert.equal(started, false);
});

test("background list labels jobs by purpose and retains commands and legacy fallback", async () => {
  const current = fakeToolContext();
  const legacy = (await current.backgroundList())[0]!;
  current.backgroundList = async () => [
    { ...legacy, purpose: "Run regression tests" },
    { ...legacy, processId: "old-job" },
  ];
  const tool = createAgentTools(createTurnToolState({ current })).find((t) => t.name === "background")!;
  const result = textOut(await call(tool, { action: "list" }));
  assert.match(result, /Run regression tests\n {2}bg: npm test/);
  assert.match(result, /old-job[^\n]*bg: npm test/);
});

test("sessions search forwards a bounded query and preserves source references and failures", async () => {
  const tc = fakeToolContext();
  const seen: unknown[] = [];
  tc.sessionSyscalls = {
    open: async () => ({ ok: false, message: "unused" }),
    write: async () => ({ ok: false, message: "unused" }),
    read: async () => ({ ok: false, message: "unused" }),
    search: async (input) => {
      seen.push(input);
      return {
        hits: [
          {
            id: "source:7",
            type: "conversation",
            backend: "conversations",
            snippet: "memo",
            metadata: { sessionId: "source", seq: 7 },
          },
        ],
        failedBackends: ["conversations"],
      };
    },
  };
  const tool = createAgentTools(createTurnToolState({ current: tc }), { surfaceName: "web" }).find(
    (t) => t.name === "sessions",
  )!;
  assert.match(textOut(await call(tool, { action: "search" })), /requires `query`/);
  assert.deepEqual(seen, []);
  const output = JSON.parse(textOut(await call(tool, { action: "search", query: "memo", limit: 3 })));
  assert.deepEqual(seen, [{ query: "memo", limit: 3 }]);
  assert.deepEqual(output.hits[0].metadata, { sessionId: "source", seq: 7 });
  assert.deepEqual(output.failedBackends, ["conversations"]);
});

test("invalid execution arguments cannot dispatch commands or retarget process operations", async () => {
  let dispatched = 0;
  const current = {
    ...fakeToolContext(),
    execute: async () => {
      dispatched++;
      throw new Error("unexpected command");
    },
    backgroundStart: async () => {
      dispatched++;
      throw new Error("unexpected start");
    },
    backgroundPoll: async () => {
      dispatched++;
      throw new Error("unexpected poll");
    },
  };
  const tools = createAgentTools(createTurnToolState({ current }));
  for (const params of [
    {},
    { command: "pwd", purpose: "Check computer", background: "false" },
    { command: "pwd", purpose: "Check computer", sandbox_id: "" },
  ])
    assert.match(
      textOut(
        await call(
          tools.find((t) => t.name === "execute"),
          params,
        ),
      ),
      /invalid execute arguments/,
    );
  assert.match(
    textOut(
      await call(
        tools.find((t) => t.name === "background"),
        { action: "poll", process_id: "job-a", sandbox_id: "box-b" },
      ),
    ),
    /invalid background arguments/,
  );
  assert.equal(dispatched, 0);
});

test("split sandbox tools reject missing, mistyped, blank and unrelated fields without dispatch", async () => {
  let dispatched = 0;
  const tc = new Proxy(
    { ...fakeToolContext(), sandboxResources: async () => ({ ok: true }) },
    {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return () => {
          dispatched++;
          throw new Error("must not dispatch");
        };
      },
    },
  );
  const tools = createAgentTools(createTurnToolState({ current: tc }));
  const inputs: Record<string, object[]> = {
    sandbox: [
      { action: "__proto__" },
      { action: "constructor" },
      { action: "retire", sandbox_id: null, purpose: "test" },
      { action: "retire", sandbox_id: " ", purpose: "test" },
      { action: "status", sandbox_id: null, purpose: "test" },
      { action: "create", backend: "modal", command: "ignored", purpose: "test" },
      { action: "create", backend: 42, purpose: "test" },
      { action: "create", backend: " ", purpose: "test" },
      { action: "set_default", purpose: "test" },
      { action: "list", purpose: " " },
    ],
    execute: [
      { command: "", purpose: "test" },
      { command: " ", purpose: "test", background: true },
      { command: "pwd", purpose: " " },
      { command: "pwd", purpose: " ", background: true },
    ],
    background: [
      { action: "poll", process_id: "job", sandbox_id: "other-box" },
      { action: "poll", process_id: " " },
      { action: "send_input", process_id: "job" },
      { action: "stop", process_id: "job", signal: "NOPE" },
      { action: "watch", process_id: "job", since_cursor: -1 },
      { action: "unwatch", monitor_id: null },
      { action: "list", command: "ignored" },
    ],
  };
  for (const [name, cases] of Object.entries(inputs))
    for (const input of cases)
      assert.match(
        textOut(
          await call(
            tools.find((t) => t.name === name),
            input,
          ),
        ),
        /\[error\]/,
      );
  assert.equal(dispatched, 0);
});

test("native skills discovery exposes list and search with validated pagination", async () => {
  const ctx = fakeToolContext();
  const seen: unknown[] = [];
  ctx.listSkills = async (...args) => {
    seen.push(args);
    return { sourceScopeId: null, skills: [{ name: "rare-helper", description: "Rare task" }] };
  };
  const tool = createAgentTools(createTurnToolState({ current: ctx })).find((t) => t.name === "skills")!;
  assert.match(textOut(await call(tool, { action: "search", query: "rare", limit: 10 })), /rare-helper/);
  await call(tool, { action: "list", offset: 4, limit: 2 });
  assert.deepEqual(seen, [
    ["rare", undefined, 10, undefined],
    [undefined, 4, 2, undefined],
  ]);
  for (const input of [{ action: "search" }, { action: "list", limit: 101 }, { action: "list", offset: -1 }]) {
    assert.match(textOut(await call(tool, input)), /Invalid arguments/);
  }
});

test("client screenshots reach the model as images and remain subject to output screening", async () => {
  const { store, ref } = clientToolRef();
  const image = { data: "aGVsbG8=", mimeType: "image/png" as const };
  let unscreenable = false;
  ref.observeToolResult = (input) => {
    unscreenable = input.unscreenable;
  };
  const tool = createAgentTools(createTurnToolState(ref), { clientTools: [clientTool("desktop")] }).at(-1)!;
  const pending = call(tool, { note: "screen" }) as Promise<{ content: unknown[] }>;
  await store.send("run-1", { kind: "client_result", callId: "t", result: { content: "Calculator", images: [image] } });
  assert.deepEqual((await pending).content, [
    { type: "text", text: "Calculator" },
    { type: "image", ...image },
  ]);
  assert.equal(unscreenable, true);
});

test("installing a shared sidebar always waits for the person's approval", async () => {
  const installed: string[] = [];
  const approved = new Set<string>();
  const ref: TurnToolStateInit = {
    current: {
      ...fakeToolContext(),
      installSharedCanvas: async (id) => {
        installed.push(id);
        return null;
      },
    },
    scopeLabel: "personal:U1",
    toolApprovalGate: (callKey) => !callKey || approved.has(callKey),
  };
  const state = createTurnToolState(ref);
  const files = createAgentTools(state).find((t) => t.name === "files")!;
  await call(files, { action: "install_canvas", id: "f1" });
  assert.deepEqual(installed, []);
  const card = state.halt.approvals()[0];
  assert.deepEqual(
    [card?.command, card?.summary, card?.reason, card?.grantModes],
    [
      'files install_canvas {"action":"install_canvas","id":"f1"}',
      "files install_canvas",
      "install an always-on canvas someone shared with you; its code runs in your QM web UI",
      { session: false, always: false },
    ],
  );
  approved.add(card!.approvalKey!);
  await call(files, { action: "install_canvas", id: "f2" });
  assert.deepEqual(installed, [], "the approval covers only the approved arguments");
  assert.match(textOut(await call(files, { action: "install_canvas", id: "f1" })), /Installed/);
  assert.deepEqual(installed, ["f1"]);
  ref.current = fakeToolContext();
  const plain = createAgentTools(createTurnToolState(ref)).find((t) => t.name === "files")!;
  assert.doesNotMatch(JSON.stringify(plain.parameters), /install_canvas/);
});

test("an MCP tool that needs approval is not called until its exact arguments are approved", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const approved = new Set<string>();
  const ref: TurnToolStateInit = {
    current: {
      ...fakeToolContext(),
      callMcpTool: async (_name, args) => {
        calls.push(args);
        return "deleted";
      },
    },
    scopeLabel: "personal:U1",
    toolApprovalGate: (callKey) => !callKey || approved.has(callKey),
  };
  const descriptor = {
    serverId: "example",
    description: "Example",
    inputSchema: { type: "object", properties: {} },
    readOnly: false,
  };
  const state = createTurnToolState(ref);
  const tools = createAgentTools(state, {
    mcpTools: [
      { ...descriptor, name: "example_delete", remoteName: "delete", needsApproval: true },
      { ...descriptor, name: "example_get", remoteName: "get", needsApproval: false },
    ],
  });
  const del = tools.find((t) => t.name === "example_delete")!;
  const get = tools.find((t) => t.name === "example_get")!;
  assert.match(textOut(await call(get, { id: 1 })), /deleted/);
  assert.match(textOut(await call(del, { id: 1 })), /blocked: needs human approval/);
  assert.deepEqual(calls, [{ id: 1 }]);
  const card = state.halt.approvals().at(-1)!;
  assert.equal(card.command, 'example_delete {"id":1}');
  approved.add(card.approvalKey!);
  await call(del, { id: 2 });
  assert.deepEqual(calls, [{ id: 1 }]);
  await call(del, { id: 1 });
  assert.deepEqual(calls, [{ id: 1 }, { id: 1 }]);
  await call(del, { id: 4, auth: { apiKey: "sk-live-abcdef" }, note: "y".repeat(1000) });
  assert.equal(
    state.halt.approvals().at(-1)!.command,
    `example_delete {"auth":{"apiKey":"[redacted]"},"id":4,"note":"${"y".repeat(1000)}"}`,
  );
  const cards = state.halt.approvals().length;
  assert.match(textOut(await call(del, { id: 3, note: "x".repeat(20_000) })), /too long to show on an approval card/);
  assert.equal(
    state.halt.approvals().length,
    cards,
    "an argument set the card cannot show is never offered for approval",
  );
});

function catalogTools(state: TurnToolState, name = "records") {
  return createAgentTools(state, {
    mcpTools: [
      {
        name,
        serverId: name,
        remoteName: "",
        catalog: true,
        description: "Catalog",
        inputSchema: { type: "object", properties: {} },
        readOnly: false,
        needsApproval: false,
      },
    ],
  });
}

test("a catalog tool asks per call and forwards the approval only on the approved call", async () => {
  const calls: Array<[Record<string, unknown>, string | undefined]> = [];
  const approved = new Set<string>();
  const ref: TurnToolStateInit = {
    current: {
      ...fakeToolContext(),
      mcpToolNeedsApproval: async (_name, args) => args.operation === "invoke" && args.tool === "send-message",
      callMcpTool: async (_name, args, approval) => {
        calls.push([args, approval]);
        return "ok";
      },
    },
    scopeLabel: "personal:U1",
    toolApprovalGate: (callKey) => !callKey || approved.has(callKey),
  };
  const state = createTurnToolState(ref);
  const catalog = catalogTools(state).find((t) => t.name === "records")!;
  const send = { operation: "invoke", tool: "send-message", arguments: { to: "x" } };
  await call(catalog, { operation: "invoke", tool: "find", arguments: {} });
  await call(catalog, send);
  assert.deepEqual(calls, [[{ operation: "invoke", tool: "find", arguments: {} }, undefined]]);
  const card = state.halt.approvals().at(-1)!;
  assert.equal(card.command, 'records {"arguments":{"to":"x"},"operation":"invoke","tool":"send-message"}');
  approved.add(card.approvalKey!);
  await call(catalog, send);
  assert.deepEqual(calls.at(-1), [send, card.approvalKey]);
  approved.clear();
  await call(catalog, send);
  assert.equal(calls.length, 2, "the next identical call needs its own approval");
  assert.equal(state.halt.approvals().length, 2);
});

test("a failing approval check returns its error to the model and offers no card", async () => {
  let ran = false;
  const ref: TurnToolStateInit = {
    current: {
      ...fakeToolContext(),
      mcpToolNeedsApproval: async () => {
        throw new Error("Unknown Records tool: nope. Search for it first.");
      },
      callMcpTool: async () => {
        ran = true;
        return "ok";
      },
    },
    toolApprovalGate: () => true,
  };
  const state = createTurnToolState(ref);
  const catalog = catalogTools(state).find((t) => t.name === "records")!;
  assert.match(
    textOut(await call(catalog, { operation: "invoke", tool: "nope" })),
    /could not check whether this call needs approval: Unknown Records tool: nope/,
  );
  assert.equal(ran, false);
  assert.deepEqual(state.halt.approvals(), []);
});

test("a catalog named like a native tool never replaces it or widens read-only turns", () => {
  const ref: TurnToolStateInit = { current: fakeToolContext() };
  const files = catalogTools(createTurnToolState(ref), "files").filter((t) => t.name === "files");
  assert.equal(files.length, 1);
  assert.doesNotMatch(files[0]!.description, /^Catalog/);
  const readOnly = createAgentTools(createTurnToolState(ref), {
    readOnly: true,
    mcpTools: [
      {
        name: "files",
        serverId: "files",
        remoteName: "",
        catalog: true,
        description: "Catalog",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
        needsApproval: false,
      },
    ],
  });
  assert.ok(!readOnly.some((t) => t.name === "files"));
});

test("a tool that needs approval fails closed without an approval gate", async () => {
  let called = false;
  const ref: TurnToolStateInit = {
    current: {
      ...fakeToolContext(),
      callMcpTool: async () => {
        called = true;
        return "";
      },
    },
  };
  const [tool] = createAgentTools(createTurnToolState(ref), {
    mcpTools: [
      {
        name: "example_delete",
        serverId: "example",
        remoteName: "delete",
        description: "Delete",
        inputSchema: { type: "object", properties: {} },
        readOnly: false,
        needsApproval: true,
      },
    ],
  }).filter((t) => t.name === "example_delete");
  assert.match(textOut(await call(tool!, {})), /blocked: needs human approval/);
  assert.equal(called, false);
});
