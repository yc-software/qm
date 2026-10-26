import { activitySeq } from "../src/items.ts";
import { item } from "./item-fixture.ts";
import { buildTimeline } from "../src/timeline.ts";
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
  return { acc: "", startOffset: 0, lastProgressAt: t0 };
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
    activity: Array.from({ length: n }, (_, i) => ({ item: item("ToolCall", { seq: i }) })),
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
    activity: [{ item: item("ToolCall", { seq: 1, createdAt: 100, tool: "execute" }) }],
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
        item: item("ToolCall", {
          seq: 1,
          createdAt: 100,
          tool: "execute",
          body: { command: "git push --force origin main" },
        }),
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
    activity: [{ item: item("ToolCall", { seq: 1, createdAt: 100, tool: "background" }) }],
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
    result: { status: "refused", refusalKind: "approval_denied", reason: "the approver declined this push" },
    partial: "",
    activity: [
      {
        item: item("ToolCall", {
          seq: 1,
          createdAt: 100,
          tool: "execute",
          body: { command: "git push --force origin main" },
        }),
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

test("a refusal that only mentions a denied approval in its reason is a failure, not a denial", async () => {
  const streamFn = makeRunResumeStreamFn("run-refused", {
    status: "done",
    result: { status: "refused", reason: "approval denied for git push --force origin main" },
    partial: "",
    startedAt: 100,
    finishedAt: 200,
  });
  const final = await drain(await streamFn(MODEL, { systemPrompt: "", messages: [], tools: [] } as never));

  assert.equal((final as AssistantWork & { approvalDecision?: string }).approvalDecision, undefined);
  assert.equal((final as AssistantWork).work?.status, "failed");
});

test("a failed run renders friendly copy, never the internal failure reason", async () => {
  setClock(() => 1_000_000);
  instantSleep();
  stubRuns([
    { status: "failed", result: { status: "failed", reason: "TypeError: fetch failed at sandbox.ts:42" }, partial: "" },
  ]);

  const stream = createAssistantMessageEventStream();
  await pollRun(stream, blankAssistant(), "run-failed-copy", freshAcc(1_000_000));
  const final = await drain(stream);

  assert.equal(final.stopReason, "error");
  assert.doesNotMatch(final.errorMessage ?? "", /TypeError|sandbox\.ts/, "raw internals never reach the transcript");
  assert.equal(final.errorMessage, "Something went wrong on my end and I couldn't finish that. Try again in a moment.");
});

test("a refused run still shows its authored, user-facing reason", async () => {
  setClock(() => 1_000_000);
  instantSleep();
  stubRuns([
    { status: "done", result: { status: "refused", reason: "you're not a member of that context" }, partial: "" },
  ]);

  const stream = createAssistantMessageEventStream();
  await pollRun(stream, blankAssistant(), "run-refused-copy", freshAcc(1_000_000));
  const final = await drain(stream);

  assert.equal(final.stopReason, "error");
  assert.equal(final.errorMessage, "you're not a member of that context");
});

test("a stored quarantine refusal renders the canned copy on the web, never the internal verdict", async () => {
  setClock(() => 1_000_000);
  instantSleep();
  stubRuns([
    {
      status: "done",
      result: { status: "refused", refusalKind: "security_quarantine", reason: "internal screening details" },
      partial: "",
    },
  ]);

  const stream = createAssistantMessageEventStream();
  await pollRun(stream, blankAssistant(), "run-quarantine-copy", freshAcc(1_000_000));
  const final = await drain(stream);

  assert.equal(final.stopReason, "error");
  assert.doesNotMatch(final.errorMessage ?? "", /internal screening details/);
  assert.match(final.errorMessage ?? "", /security screen flagged/);
});

test("live run polling includes consumed steering in activity order", async () => {
  instantSleep();
  stubRuns([
    {
      status: "done",
      result: { status: "ok", reply: "Done" },
      activity: [
        { item: item("UserMessage", { seq: 1, createdAt: 1, text: "start" }) },
        { item: item("ToolCall", { seq: 2, createdAt: 2, tool: "execute", callId: "a" }) },
        { item: item("ToolResult", { seq: 3, createdAt: 3, tool: "execute", callId: "a" }) },
        { item: item("SteeringMessage", { seq: 4, createdAt: 4, text: "Change direction" }) },
        { item: item("ToolCall", { seq: 6, createdAt: 6, tool: "execute", callId: "b" }) },
      ],
    },
  ]);
  const stream = createAssistantMessageEventStream();
  const partial = blankAssistant() as AssistantWork;
  partial.work = { status: "thinking", activity: [] };
  await pollRun(stream, partial, "run-steer", freshAcc(Date.now()));
  const final = (await drain(stream)) as AssistantWork;
  assert.deepEqual(final.work!.activity.map(activitySeq), [2, 3, 4, 6]);
  assert.deepEqual(
    buildTimeline(final.work!).map((item) => item.kind),
    ["tool", "steer", "tool"],
  );
});

test("polling advances a trimmed window even when every snapshot has the same length", async () => {
  instantSleep();
  stubRuns([
    { status: "running", result: null, partial: "first tail", partialStartOffset: 200_000 },
    { status: "running", result: null, partial: "later tail", partialStartOffset: 200_010 },
    { status: "done", result: { status: "ok" }, partial: "final tail", partialStartOffset: 200_020 },
  ]);
  const stream = createAssistantMessageEventStream();
  const partial = blankAssistant();
  const st = freshAcc(Date.now());
  await pollRun(stream, partial, "r", st);
  assert.deepEqual((await drain(stream)).content, [{ type: "text", text: "final tail" }]);
  assert.equal(st.startOffset, 200_020);
});
