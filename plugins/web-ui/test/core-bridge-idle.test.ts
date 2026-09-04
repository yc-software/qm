import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model, Api } from "@earendil-works/pi-ai";
import {
  makeRunResumeStreamFn,
  pollRun,
  setClock,
  RUN_IDLE_MS,
  type Acc,
  type AssistantWork,
} from "../src/core-bridge.ts";

const MODEL = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Model<Api>;

function blankAssistant(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function freshAcc(t0: number): Acc {
  return { acc: "", lastProgressAt: t0 };
}

function drain(stream: ReturnType<typeof createAssistantMessageEventStream>): Promise<AssistantMessage> {
  return stream.result();
}

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
afterEach(() => {
  setClock(() => Date.now());
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
});

function instantSleep(): void {
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void) => {
    queueMicrotask(() => fn());
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
}

function stubRuns(snapshots: Array<Record<string, unknown>>): void {
  let i = 0;
  globalThis.fetch = (async () => {
    const body = snapshots[Math.min(i, snapshots.length - 1)] ?? {};
    i++;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as typeof fetch;
}

test("the idle deadline RESETS on each delta — sustained progress past the window never times out", async () => {
  let clock = 1_000_000;
  setClock(() => clock);
  instantSleep();

  const step = RUN_IDLE_MS - 1;
  const partials = ["aa", "aabb", "aabbcc", "aabbccdd", "aabbccddee"];
  const snapshots: Array<Record<string, unknown>> = partials.map((p) => ({
    status: "running",
    result: null,
    partial: p,
  }));
  snapshots.push({ status: "done", result: { status: "ok", reply: "aabbccddeeFINAL" }, partial: "aabbccddee" });

  let i = 0;
  globalThis.fetch = (async () => {
    const body = snapshots[Math.min(i, snapshots.length - 1)] ?? {};
    i++;
    clock += step;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as typeof fetch;

  const stream = createAssistantMessageEventStream();
  const partial = blankAssistant();
  const st = freshAcc(clock);

  await pollRun(stream, partial, "run-1", st);
  const final = await drain(stream);

  assert.equal(final.stopReason, "stop", "completed on the real reply, not a timeout");
  const block = final.content[0];
  assert.equal(block?.type === "text" ? block.text : "", "aabbccddeeFINAL");
});

test("the idle deadline DOES fire after the idle window with no progress", async () => {
  let clock = 2_000_000;
  setClock(() => clock);
  instantSleep();

  stubRuns([{ status: "running", result: null, partial: "stuck" }]);

  const stream = createAssistantMessageEventStream();
  const partial = blankAssistant();
  const st = freshAcc(clock);
  st.acc = "stuck";

  const realF = globalThis.fetch;
  let polls = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    polls++;
    if (polls >= 2) clock += RUN_IDLE_MS + 1;
    return realF(...args);
  }) as typeof fetch;

  await pollRun(stream, partial, "run-2", st);
  const final = await drain(stream);

  assert.equal(final.stopReason, "error", "a silent run past the idle window fails");
  assert.equal(final.errorMessage, "Timed out waiting for the agent to respond.");
});

test("a delta just before the window resets it — no premature timeout", async () => {
  let clock = 3_000_000;
  setClock(() => clock);
  instantSleep();

  const snapshots: Array<Record<string, unknown>> = [
    { status: "running", result: null, partial: "x" },
    { status: "running", result: null, partial: "x" },
    { status: "done", result: { status: "ok", reply: "xy" }, partial: "x" },
  ];
  let i = 0;
  globalThis.fetch = (async () => {
    const body = snapshots[Math.min(i, snapshots.length - 1)] ?? {};
    i++;
    clock += Math.floor(RUN_IDLE_MS / 4);
    return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as typeof fetch;

  const stream = createAssistantMessageEventStream();
  const partial = blankAssistant();
  const st = freshAcc(clock);

  await pollRun(stream, partial, "run-3", st);
  const final = await drain(stream);
  assert.equal(final.stopReason, "stop", "the pre-window delta reset the clock; no premature timeout");
});

test("tool-activity growth (no assistant text) ALSO resets the idle clock", async () => {
  let clock = 4_000_000;
  setClock(() => clock);
  instantSleep();

  const step = RUN_IDLE_MS - 1;
  const snapshots: Array<Record<string, unknown>> = [1, 2, 3, 4, 5].map((n) => ({
    status: "running",
    result: null,
    partial: "",
    activity: Array.from({ length: n }, (_, i) => ({ seq: i, type: "tool_call" })),
  }));
  snapshots.push({
    status: "done",
    result: { status: "ok", reply: "done" },
    partial: "",
    activity: snapshots[snapshots.length - 1]!.activity,
  });

  let i = 0;
  globalThis.fetch = (async () => {
    const body = snapshots[Math.min(i, snapshots.length - 1)] ?? {};
    i++;
    clock += step;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as typeof fetch;

  const stream = createAssistantMessageEventStream();
  const partial = blankAssistant();
  (partial as AssistantWork).work = { status: "thinking", activity: [] };
  const st = freshAcc(clock);

  await pollRun(stream, partial, "run-4", st);
  const final = await drain(stream);

  assert.equal(final.stopReason, "stop", "tool activity counts as progress; no false timeout on a tool-only turn");
});

test("core-attested liveness (alive:true) resets the idle clock — a long silent tool call never times out", async () => {
  let clock = 5_000_000;
  setClock(() => clock);
  instantSleep();

  const step = RUN_IDLE_MS - 1;
  const snapshots: Array<Record<string, unknown>> = [1, 2, 3, 4, 5].map(() => ({
    status: "running",
    result: null,
    partial: "",
    alive: true,
  }));
  snapshots.push({ status: "done", result: { status: "ok", reply: "finally" }, partial: "" });

  let i = 0;
  globalThis.fetch = (async () => {
    const body = snapshots[Math.min(i, snapshots.length - 1)] ?? {};
    i++;
    clock += step;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as typeof fetch;

  const stream = createAssistantMessageEventStream();
  const partial = blankAssistant();
  const st = freshAcc(clock);

  await pollRun(stream, partial, "run-5", st);
  const final = await drain(stream);

  assert.equal(final.stopReason, "stop", "alive polls count as progress; no false timeout during a quiet tool call");
  const block = final.content[0];
  assert.equal(block?.type === "text" ? block.text : "", "finally");
});

test("a running snapshot WITHOUT alive still hits the idle deadline (stale run record)", async () => {
  let clock = 6_000_000;
  setClock(() => clock);
  instantSleep();

  stubRuns([{ status: "running", result: null, partial: "" }]);

  const realF = globalThis.fetch;
  let polls = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    polls++;
    if (polls >= 2) clock += RUN_IDLE_MS + 1;
    return realF(...args);
  }) as typeof fetch;

  const stream = createAssistantMessageEventStream();
  const partial = blankAssistant();
  const st = freshAcc(clock);

  await pollRun(stream, partial, "run-6", st);
  const final = await drain(stream);

  assert.equal(final.stopReason, "error", "no liveness claim → the watchdog still protects against stale runs");
  assert.equal(final.errorMessage, "Timed out waiting for the agent to respond.");
});

test("resume streams can finish from an initial terminal run snapshot without polling", async () => {
  globalThis.fetch = (async () => {
    throw new Error("resume should not poll after a terminal initial snapshot");
  }) as typeof fetch;

  const streamFn = makeRunResumeStreamFn("run-terminal", {
    status: "done",
    result: { status: "ok", reply: "done" },
    partial: "do",
    activity: [{ seq: 1, type: "tool_call", payload: { tool: "execute" }, createdAt: 100 }],
    startedAt: 100,
    finishedAt: 200,
  });
  const stream = await streamFn(MODEL, { systemPrompt: "", messages: [], tools: [] } as never);
  const final = await drain(stream);
  const block = final.content[0];
  const work = (final as AssistantWork).work;

  assert.equal(block?.type === "text" ? block.text : "", "done");
  assert.equal(work?.status, "complete");
  assert.equal(work?.startedAt, 100);
  assert.equal(work?.finishedAt, 200);
  assert.equal(work?.activity.length, 1);
});

test("pending approval pauses without adding approval instructions to the transcript", async () => {
  globalThis.fetch = (async () => {
    throw new Error("pending approval terminal snapshot should not poll");
  }) as typeof fetch;

  const streamFn = makeRunResumeStreamFn("run-paused", {
    status: "done",
    result: {
      status: "pending_approval",
      reason: "Approve or deny the pending command to continue.",
      pendingApprovals: [{ requestId: "approval-1", command: "git push --force origin main", reason: "force push" }],
    },
    partial: "",
    activity: [
      {
        seq: 1,
        type: "tool_call",
        payload: { tool: "execute", command: "git push --force origin main" },
        createdAt: 100,
      },
    ],
    startedAt: 100,
    finishedAt: 200,
  });
  const stream = await streamFn(MODEL, { systemPrompt: "", messages: [], tools: [] } as never);
  const final = await drain(stream);
  const block = final.content[0];
  const work = (final as AssistantWork).work;

  assert.equal(block?.type === "text" ? block.text : "", "");
  assert.equal(work?.status, "complete");
  assert.equal(work?.activity.length, 1);
});

test("a reattached background wake that ended silent is a clean stop, never 'The agent run failed.'", async () => {
  globalThis.fetch = (async () => {
    throw new Error("silent terminal snapshot should not poll");
  }) as typeof fetch;

  const streamFn = makeRunResumeStreamFn("run-silent", {
    status: "done",
    result: { status: "silent" },
    partial: "",
    activity: [{ seq: 1, type: "tool_call", payload: { tool: "background" }, createdAt: 100 }],
    startedAt: 100,
    finishedAt: 200,
  });
  const stream = await streamFn(MODEL, { systemPrompt: "", messages: [], tools: [] } as never);
  const final = await drain(stream);
  const work = (final as AssistantWork).work;

  assert.equal(final.stopReason, "stop", "a silent wake is a clean terminal, not an error");
  assert.equal(final.errorMessage, undefined);
  assert.equal(work?.status, "complete");
});

test("approval denial is rendered as a normal status, not a stream error", async () => {
  globalThis.fetch = (async () => {
    throw new Error("approval denial terminal snapshot should not poll");
  }) as typeof fetch;

  const streamFn = makeRunResumeStreamFn("run-denied", {
    status: "done",
    result: { status: "refused", reason: "approval denied for git push --force origin main" },
    partial: "",
    activity: [
      {
        seq: 1,
        type: "tool_call",
        payload: { tool: "execute", command: "git push --force origin main" },
        createdAt: 100,
      },
    ],
    startedAt: 100,
    finishedAt: 200,
  });
  const stream = await streamFn(MODEL, { systemPrompt: "", messages: [], tools: [] } as never);
  const final = await drain(stream);
  const block = final.content[0];
  const work = (final as AssistantWork).work;

  assert.equal(final.stopReason, "stop");
  assert.equal(final.errorMessage, undefined);
  assert.equal((final as AssistantWork & { approvalDecision?: string }).approvalDecision, "denied");
  assert.equal(block?.type === "text" ? block.text : "", "Denied.");
  assert.equal(work?.status, "complete");
  assert.equal(work?.activity.length, 1);
});
