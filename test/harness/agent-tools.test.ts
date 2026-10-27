import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentTools } from "../../src/harness/agent-tools.ts";
import { createTurnToolState, type TurnToolStateInit } from "../../src/harness/turn-tool-state.ts";
import { reconstructMessagesFromHistory } from "../../src/harness/replay.ts";
import { NeedsApproval } from "../../src/tools/primitives.ts";
import { createPostgresToolOutputStore, parkedOutputKey } from "../../src/sessions/tool-output.ts";
import { createMemoryDurableByteStore } from "../../src/files/durable-byte-store.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { storedItem, type NewItem } from "../../src/sessions/items.ts";
import type { ComputerStatus } from "../../src/sandbox/sandbox.ts";
import { fakeToolContext, type Emitted, emittedItem, call, textOut } from "../support/agent-tools.ts";

test("each agent tool emits a tool_call then a tool_result", async () => {
  const emitted: Emitted[] = [];
  const ref: TurnToolStateInit = {
    current: fakeToolContext(),
    emit: (e) => {
      emitted.push(emittedItem(e));
    },
    scopeLabel: "personal:U1",
  };
  const [execute, , read] = createAgentTools(createTurnToolState(ref), { controlTools: true });
  const write = read;

  await call(execute, { command: "echo hi", purpose: "Run test command" });
  await call(read, { action: "read", path: "a.txt" });
  await call(write, { action: "write", path: "out.txt", data: "xyz" });
  await call(write, { action: "share", id: "file-id", toScope: "org" });

  assert.deepEqual(
    emitted.map((e) => `${e.kind}:${e.fields.tool}`),
    [
      "ToolCall:execute",
      "ToolResult:execute",
      "ToolCall:files",
      "ToolResult:files",
      "ToolCall:files",
      "ToolResult:files",
      "ToolCall:files",
      "ToolResult:files",
    ],
  );
  assert.equal(emitted[1]!.fields.code, 0);
  assert.equal(emitted[3]!.fields.found, true);
  assert.equal(emitted[5]!.fields.bytes, 3);
  assert.equal(emitted[7]!.fields.verb, "share");
});

test("sandbox manages the box out-of-band instead of running a command", async () => {
  const restarted: number[] = [];
  const tc = {
    ...fakeToolContext(),
    restartComputer: async () => {
      restarted.push(1);
    },
    computerStatus: async () => ({
      machine: "healthy",
      provisioned: true,
      guestResponsive: false,
      probeError:
        "fetch failed <- Error ERR_HTTP2_GOAWAY_SESSION: New streams cannot be created after receiving a GOAWAY",
    }),
  };
  const ref: TurnToolStateInit = { current: tc, emit: () => {}, scopeLabel: "personal:U1" };
  const execute = createAgentTools(createTurnToolState(ref)).find((t) => t.name === "sandbox")!;

  const status = (await call(execute, { action: "status", purpose: "p" })) as {
    content: Array<{ text?: string }>;
  };
  assert.match(
    status.content[0]!.text!,
    /machine: healthy; shell: NOT answering \(fetch failed <- Error ERR_HTTP2_GOAWAY_SESSION/,
    "the probe's real cause reaches the agent instead of a bare verdict",
  );
  assert.match(
    status.content[0]!.text!,
    /WEDGED: a machine exists but its shell is not answering/,
    "a provisioned machine with a dead guest is called out as wedged, not left as two contradicting fields",
  );

  const restart = (await call(execute, { action: "restart", purpose: "p" })) as {
    content: Array<{ text?: string }>;
  };
  assert.equal(restarted.length, 1);
  assert.match(restart.content[0]!.text!, /restarting/i);

  const unsupported = createAgentTools(
    createTurnToolState({
      ...ref,
      current: {
        ...tc,
        restartComputer: async () => {
          throw new Error("this computer's substrate (local) does not support restarting the computer");
        },
      },
    }),
  ).find((t) => t.name === "sandbox")!;
  const err = (await call(unsupported, { action: "restart", purpose: "p" })) as {
    content: Array<{ text?: string }>;
  };
  assert.match(err.content[0]!.text!, /does not support restarting/);
});

test("sandbox advertises available management actions and retires migrate", async () => {
  const ref: TurnToolStateInit = { current: fakeToolContext(), emit: () => {}, scopeLabel: "personal:U1" };
  const enabled = createAgentTools(createTurnToolState(ref));
  const sandbox = enabled.find((t) => t.name === "sandbox")!;
  const properties = (sandbox.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
  assert.deepEqual(properties.action!.enum, ["status", "restart", "list", "create", "set_default", "retire"]);
  assert.ok(enabled.some((t) => t.name === "execute"));
  assert.ok(enabled.some((t) => t.name === "background"));
  const execute = createAgentTools(createTurnToolState(ref)).find((t) => t.name === "execute")!;
  assert.equal("computer" in (execute.parameters as { properties: object }).properties, false);
  assert.equal("to" in (execute.parameters as { properties: object }).properties, false);
  assert.match(textOut(await call(sandbox, { action: "migrate", purpose: "p" })), /invalid sandbox arguments/);
  assert.match(textOut(await call(execute, { command: "", computer: "migrate" })), /invalid execute arguments/);
});

test("sandbox creation and default routing remain independent", async () => {
  const calls: unknown[] = [];
  const ref: TurnToolStateInit = {
    current: {
      ...fakeToolContext(),
      async sandboxResources(action, input) {
        calls.push({ action, input });
        return { ok: true };
      },
    },
  };
  const sandbox = createAgentTools(createTurnToolState(ref)).find((t) => t.name === "sandbox")!;
  await call(sandbox, { action: "create", backend: "modal", name: "analysis", purpose: "p" });
  assert.deepEqual(calls, [{ action: "create", input: { backend: "modal", name: "analysis", sandboxId: undefined } }]);
  await call(sandbox, { action: "set_default", sandbox_id: null, purpose: "p" });
  assert.deepEqual(calls[1], { action: "default", input: { backend: undefined, name: undefined, sandboxId: null } });
});

test("sandbox management preserves approval handling", async () => {
  const ref: TurnToolStateInit = {
    current: {
      ...fakeToolContext(),
      async restartComputer() {
        throw new NeedsApproval("restart", "restart requested", "approval");
      },
    },
  };
  const state = createTurnToolState(ref);
  const sandbox = createAgentTools(state).find((t) => t.name === "sandbox")!;
  assert.match(
    textOut(await call(sandbox, { action: "restart", purpose: "Recover the shell" })),
    /needs human approval/,
  );
  assert.equal(state.halt.pausedOnApproval(), true);
  assert.equal(state.halt.approvals()[0]!.purpose, "Recover the shell");
});

test("computer status surfaces list-view disagreement and guest pressure", async () => {
  const tc = {
    ...fakeToolContext(),
    computerStatus: async () => ({
      machine: "healthy",
      listed: "cold",
      guestResponsive: true,
      pressure: { ioFull10: 90, ioFull60: 86.14, load1: 30.78 },
    }),
    restartComputer: async () => {},
  };
  const ref: TurnToolStateInit = { current: tc, emit: () => {}, scopeLabel: "personal:U1" };
  const execute = createAgentTools(createTurnToolState(ref)).find((t) => t.name === "sandbox")!;
  const status = (await call(execute, { action: "status", purpose: "p" })) as {
    content: Array<{ text?: string }>;
  };
  assert.match(status.content[0]!.text!, /machine: healthy \(listed: cold\)/);
  assert.match(status.content[0]!.text!, /io pressure: 86\.14% \(load 30\.78\)/);
});

test("computer status exposes paused lifecycle and recovery deadlines without claiming a failed shell", async () => {
  const ref: TurnToolStateInit = {
    current: {
      ...fakeToolContext(),
      computerStatus: async () => ({
        machine: "e2b sandbox",
        provisioned: true,
        guestResponsive: false,
        lifecycleState: "paused",
        expiresAtMs: Date.parse("2026-09-10T00:00:00Z"),
        recovery: {
          strategy: "provider_snapshot",
          checkpointId: "checkpoint-1",
          checkpointAtMs: Date.parse("2026-09-09T00:00:00Z"),
          checkpointExpiresAtMs: Date.parse("2026-10-09T00:00:00Z"),
          state: "failed",
          error: "resume failed; retry required",
        },
      }),
    },
    emit: () => {},
    scopeLabel: "personal:U1",
  };
  const execute = createAgentTools(createTurnToolState(ref)).find((t) => t.name === "sandbox")!;
  const out = (await call(execute, { action: "status", purpose: "p" })) as {
    content: Array<{ text?: string }>;
  };
  const output = out.content[0]!.text!;
  assert.match(output, /shell: paused \(not probed\)/);
  assert.doesNotMatch(output, /NOT answering|WEDGED/);
  for (const expected of [
    "lifecycle: paused",
    "machine expires: 2026-09-10T00:00:00.000Z",
    "recovery strategy: provider_snapshot",
    "recovery state: failed",
    "checkpoint: checkpoint-1",
    "checkpoint captured: 2026-09-09T00:00:00.000Z",
    "checkpoint expires: 2026-10-09T00:00:00.000Z",
    "recovery error: resume failed; retry required",
  ])
    assert.ok(output.includes(expected), expected);
});

test("computer status verdicts: answering guest is ok, dead guest without a machine is down", async () => {
  const base = fakeToolContext();
  const cases: Array<{ status: ComputerStatus; wedged: boolean }> = [
    { status: { machine: "healthy", listed: "cold", provisioned: true, guestResponsive: true }, wedged: false },
    { status: { machine: "no sandbox provisioned yet", provisioned: false, guestResponsive: false }, wedged: false },
    {
      status: {
        machine: "e2b sandbox i-123 (e2b sandbox i-123 is gone: sandbox is not running anymore)",
        provisioned: false,
        guestResponsive: false,
      },
      wedged: false,
    },
    { status: { machine: "machine in stopping state", provisioned: true, guestResponsive: false }, wedged: true },
    { status: { machine: "healthy", listed: "cold", provisioned: true, guestResponsive: false }, wedged: true },
    {
      status: { machine: "e2b sandbox i-123 (connect timeout)", provisioned: true, guestResponsive: false },
      wedged: true,
    },
    { status: { machine: "check failed: http 503", guestResponsive: false }, wedged: false },
  ];
  for (const c of cases) {
    const ref: TurnToolStateInit = {
      current: { ...base, computerStatus: async () => c.status, restartComputer: async () => {} },
      emit: () => {},
      scopeLabel: "personal:U1",
    };
    const execute = createAgentTools(createTurnToolState(ref)).find((t) => t.name === "sandbox")!;
    const out = (await call(execute, { action: "status", purpose: "p" })) as {
      content: Array<{ text?: string }>;
    };
    assert.equal(
      /WEDGED/.test(out.content[0]!.text!),
      c.wedged,
      `machine=${c.status.machine} listed=${c.status.listed ?? ""} guest=${c.status.guestResponsive}`,
    );
  }
});

test("an exec under io pressure carries a [pressure] warning; a calm one doesn't", async () => {
  const pressured = {
    ...fakeToolContext(),
    execute: async () => ({
      stdout: "ok",
      stderr: "",
      code: 0,
      timedOut: false,
      pressure: { ioFull10: 80, ioFull60: 62.4, load1: 12 },
    }),
  };
  const ref: TurnToolStateInit = { current: pressured, emit: () => {}, scopeLabel: "personal:U1" };
  const [execute] = createAgentTools(createTurnToolState(ref));
  const hot = (await call(execute, { command: "echo ok", purpose: "p" })) as { content: Array<{ text?: string }> };
  assert.match(hot.content[0]!.text!, /\[pressure\] .*io 62\.4%.*move self-contained runs to scope:"scratch"/);

  const [calmExecute] = createAgentTools(
    createTurnToolState({
      ...ref,
      current: {
        ...pressured,
        execute: async () => ({
          stdout: "ok",
          stderr: "",
          code: 0,
          timedOut: false,
          pressure: { ioFull10: 1, ioFull60: 2, load1: 0.5 },
        }),
      },
    }),
  );
  const calm = (await call(calmExecute, { command: "echo ok", purpose: "p" })) as { content: Array<{ text?: string }> };
  assert.doesNotMatch(calm.content[0]!.text!, /\[pressure\]/);

  const [reachedExecute] = createAgentTools(
    createTurnToolState({
      ...ref,
      current: {
        ...pressured,
        execute: async () => ({
          stdout: "ok",
          stderr: "",
          code: 0,
          timedOut: false,
          pressure: { ioFull10: 80, ioFull60: 62.4, load1: 12 },
          reached: { scopeId: "personal:other", label: "Other" },
        }),
      },
    }),
  );
  const reached = (await call(reachedExecute, { command: "echo ok", scope: "person:other", purpose: "p" })) as {
    content: Array<{ text?: string }>;
  };
  assert.doesNotMatch(
    reached.content[0]!.text!,
    /\[pressure\]/,
    "pressure advice about the local computer must not attach to another computer's exec",
  );
});

test("a giant tool result is capped for the model, keeping the tail and matching the persisted replay record", async () => {
  const emitted: Emitted[] = [];
  const tc = {
    ...fakeToolContext(),
    execute: async () => ({ stdout: "x".repeat(150_000), stderr: "boom", code: 1, timedOut: false }),
  };
  const ref: TurnToolStateInit = {
    current: tc,
    emit: (e) => {
      emitted.push(emittedItem(e));
    },
    scopeLabel: "personal:U1",
  };
  const [execute] = createAgentTools(createTurnToolState(ref));

  const ret = (await call(execute, { command: "curl big", purpose: "Run test command" })) as {
    content: Array<{ type: string; text: string }>;
  };
  const seen = ret.content.map((c) => c.text).join("\n");
  assert.ok(seen.length <= 100_000, `model-facing text stays within the declared cap (got ${seen.length} chars)`);
  assert.ok(seen.includes("…[truncated — full result was"), "truncation notice names the full size");
  assert.ok(seen.endsWith("[exit 1]"), "the tail — stderr and exit marker — survives the cut");
  assert.ok(seen.includes("[stderr]\nboom"), "stderr survives the cut");
  const payload = emitted.find((e) => e.kind === "ToolResult")!.fields;
  assert.equal(payload.text, seen, "the replay record is exactly what the model saw");
  assert.equal(payload.resultTruncated, true, "the entry is flagged so renderers can surface the loss");
  assert.equal(payload.stdout, undefined, "raw stdout is not stored beside the result");
  assert.equal(payload.stderr, undefined, "raw stderr is not stored beside the result");
});

test("a result over the inline cap keeps its head and tail and parks the full text where its marker points", async () => {
  const emitted: Emitted[] = [];
  const url = testDatabaseUrl();
  const store = createPostgresSessionStore(url);
  const pool = createPgPool(url);
  const session = await store.getOrCreateByThread("web:park", "dm", "personal:U1");
  const { lease } = await store.acquireLease(session.id);
  assert.ok(lease);
  await pool.q("INSERT INTO qm_settings(key, value) VALUES ('tool_result_inline_tokens', '100')");
  const clock = { at: Date.now() };
  const bytes = createMemoryDurableByteStore();
  const outputs = createPostgresToolOutputStore({ pool, bytesFor: () => bytes, now: () => clock.at });
  const appends: Promise<unknown>[] = [];
  const full = Array.from({ length: 2_000 }, (_, i) => `line ${i}`).join("\n");
  const tc = {
    ...fakeToolContext(),
    toolOutput: outputs,
    execute: async () => ({ stdout: full, stderr: "", code: 0, timedOut: false }),
  };
  const ref: TurnToolStateInit = {
    current: tc,
    emit: (e) => {
      emitted.push(emittedItem(e));
      appends.push(store.append({ ...lease, turnId: "run-park" }, e));
    },
    scopeLabel: "personal:U1",
  };
  const state = createTurnToolState(ref);
  const [execute] = createAgentTools(state);
  const ret = (await call(execute, { command: "seq", purpose: "Run test command" })) as {
    content: Array<{ type: string; text: string }>;
  };
  await Promise.all(appends);
  const seen = ret.content.map((c) => c.text).join("\n");
  const payload = emitted.find((e) => e.kind === "ToolResult")!.fields as {
    callId: string;
    text: string;
    blobSha: string;
    output: { chars: number; shownChars: number };
  };
  assert.equal(payload.text, seen, "the item stores exactly what the model saw");
  assert.ok(seen.startsWith("line 0\nline 1"), "head survives");
  assert.ok(seen.includes("[exit 0]"), "tail survives");
  const marker = parkedOutputKey(/tool-output\/\S+(?=;)/.exec(seen)![0])!;
  const parked = await outputs.read(session.id, marker);
  assert.ok(parked && "text" in parked, "the marker names the parked file");
  assert.ok(payload.output.shownChars <= 400 && seen.length < 1_000, `cut to the 100-token budget (${seen.length})`);
  assert.equal(parked.text.length, payload.output.chars);
  assert.ok(parked.text.includes("line 1999"));

  await pool.q("UPDATE qm_settings SET value = '0' WHERE key = 'tool_result_inline_tokens'");
  clock.at += 60_000;
  emitted.length = 0;
  state.routeEmit((e) => void emitted.push(emittedItem(e)));
  await call(execute, { command: "seq", purpose: "Run test command" });
  const uncapped = emitted.find((e) => e.kind === "ToolResult")!.fields as { text: string; output?: unknown };
  assert.equal(uncapped.output, undefined, "0 turns the cap off");
  assert.ok(uncapped.text.includes("line 1000"));
  await store.releaseLease(lease);
  await pool.close();
});

test("execute stores its output once and replays exactly what the model saw", async () => {
  const emitted: Emitted[] = [];
  const tc = {
    ...fakeToolContext(),
    execute: async () => ({ stdout: "built 3 files", stderr: "warning: slow disk", code: 2, timedOut: false }),
  };
  const ref: TurnToolStateInit = {
    current: tc,
    emit: (e) => {
      emitted.push(emittedItem(e));
    },
    scopeLabel: "personal:U1",
  };
  const [execute] = createAgentTools(createTurnToolState(ref));

  const live = (await call(execute, { command: "make", purpose: "Run test command" })) as {
    content: Array<{ type: string; text: string }>;
  };
  const stored = emitted.find((e) => e.kind === "ToolResult")!.fields;
  assert.deepEqual(
    { stdout: stored.stdout, stderr: stored.stderr, code: stored.code, timedOut: stored.timedOut },
    { stdout: undefined, stderr: undefined, code: 2, timedOut: false },
  );
  assert.equal(stored.text, "built 3 files\n[stderr]\nwarning: slow disk\n[exit 2]");

  const history = [{ kind: "UserMessage", text: "build it" } as NewItem, ...emitted].map((e, i) =>
    storedItem(e, { sessionId: "s", seq: i + 1, createdAt: i + 1 }),
  );
  const replayed = reconstructMessagesFromHistory(history).find((m) => m.role === "toolResult") as {
    content: Array<{ type: string; text: string }>;
    isError: boolean;
  };
  assert.deepEqual(replayed.content, live.content);
  assert.equal(replayed.isError, false);
});

test("background start and poll store their output only in result", async () => {
  const emitted: Emitted[] = [];
  const ref: TurnToolStateInit = {
    current: fakeToolContext(),
    emit: (e) => {
      emitted.push(emittedItem(e));
    },
    scopeLabel: "personal:U1",
  };
  const tools = createAgentTools(createTurnToolState(ref));
  await call(
    tools.find((t) => t.name === "execute"),
    { command: "serve", purpose: "Start server", background: true },
  );
  await call(
    tools.find((t) => t.name === "background"),
    { action: "poll", process_id: "bg-1" },
  );
  const [started, polled] = emitted.filter((e) => e.kind === "ToolResult").map((e) => e.fields);
  assert.deepEqual(
    { output: started.output, cursor: started.cursor, text: started.text },
    { output: undefined, cursor: 7, text: "started bg-1\nstarted serve\n[cursor 7 | running]" },
  );
  assert.equal(polled.chunks, undefined);
  assert.equal(polled.cursor, 18);
  assert.match(polled.text, /^more output\n\[cursor 18 \| /);
});
