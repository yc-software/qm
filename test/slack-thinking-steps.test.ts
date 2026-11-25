import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { testMap } from "./support/test-database.ts";
import { createNoopLeaderLease } from "../src/persistence/leader-lease.ts";
import { buildPlanFromActivity, isHiddenStepTool, planTitleForState, scrubStepText } from "../src/slack/step-labels.ts";
import { slackMessageContent } from "../src/slack/message-content.ts";
import { isOwnStatusCard } from "../src/slack/message-gating.ts";
import {
  createSlackThinkingStream,
  type SlackThinkingStreamRecord,
  type ThinkingStreamOptions,
} from "../src/slack/thinking-stream.ts";
import { createSlackSessionStatus, type SlackSessionStatusState } from "../src/slack/session-status.ts";
import type { Run } from "../src/runs/run-store.ts";
import type { RunActivityEntry } from "../src/runs/run-activity-store.ts";
import type { SessionWork } from "../src/sessions/session-work.ts";

interface RecordedCall {
  method: string;
  args: Record<string, unknown>;
}

function makeFakeSlackClient() {
  const calls: RecordedCall[] = [];
  const failures = new Map<string, string>();
  let seq = 0;
  return {
    calls,
    failOn(method: string, error: string) {
      failures.set(method, error);
    },
    clearFail(method: string) {
      failures.delete(method);
    },
    async apiCall(method: string, args: Record<string, unknown> = {}) {
      calls.push({ method, args });
      const errCode = failures.get(method);
      if (errCode) {
        const err = new Error(errCode) as Error & { data?: { error: string } };
        err.data = { error: errCode };
        throw err;
      }
      if (method === "chat.startStream" || method === "chat.postMessage") {
        seq += 1;
        return { ok: true, ts: `200.${seq}` };
      }
      return { ok: true, ts: (args.ts as string | undefined) ?? "200.1" };
    },
  };
}

function toolCallEntry(callId: string, tool: string, body: Record<string, unknown>, seq = 1): RunActivityEntry {
  return {
    item: {
      id: `item-${seq}`,
      seq,
      ts: 1000 + seq * 100,
      kind: "ToolCall",
      tool,
      callId,
      body,
    } as any,
  };
}

function toolResultEntry(
  callId: string,
  tool: string,
  opts: { isError?: boolean; text?: string; body?: Record<string, unknown> } = {},
  seq = 2,
): RunActivityEntry {
  return {
    item: {
      id: `item-${seq}`,
      seq,
      ts: 1000 + seq * 100,
      kind: "ToolResult",
      tool,
      callId,
      text: opts.text ?? "",
      body: { ...(opts.isError ? { isError: true } : {}), ...opts.body },
    } as any,
  };
}

function reasoningEntry(text: string, seq = 3): RunActivityEntry {
  return {
    item: {
      id: `reason-${seq}`,
      seq,
      ts: 1000 + seq * 100,
      kind: "Reasoning",
      text,
      body: {},
    } as any,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: overrides.id ?? "run-1",
    tenantId: "00000000-0000-0000-0000-000000000001",
    sessionId: overrides.sessionId ?? "sess-1",
    status: overrides.status ?? "running",
    createdAt: 1000,
    request: {
      surface: "slack",
      conversation: { kind: "channel", channelRef: "C1", threadRef: "ch:C1:100.1" },
      actor: { id: "u1", name: "Alice" },
      text: "Check status",
      origin: { kind: "human" },
      ...overrides.request,
    },
    ...(overrides.deliveryState ? { deliveryState: overrides.deliveryState } : {}),
  } as Run;
}

describe("step-labels privacy, plan building, and status-card census", () => {
  test("scrubs mentions, emails, URLs, and caps length", () => {
    const out = scrubStepText(
      "Check <@U12345> <!channel> alice@example.com https://example.com/secret and summarize the status",
      60,
    );
    assert.ok(!out.includes("<@U12345>"));
    assert.ok(!out.includes("<!channel>"));
    assert.ok(!out.includes("alice@example.com"));
    assert.equal(out.includes("https://"), false);
    assert.ok(out.length <= 60);
  });

  test("ignores Reasoning items and hidden tools completely", () => {
    assert.equal(isHiddenStepTool("finish_silently"), true);
    const built = buildPlanFromActivity(
      [
        reasoningEntry("Secret chain of thought"),
        toolCallEntry("c1", "finish_silently", { reason: "done" }, 1),
        toolCallEntry("c2", "react", { emoji: "eyes" }, 2),
      ],
      { mode: "full" },
    );
    assert.equal(built.hasVisibleActivity, false);
    assert.equal(built.tasks.length, 0);
  });

  test("never leaks raw tool command, query text, or raw output in full or brief mode", () => {
    const entries = [
      toolCallEntry("c1", "execute", { command: "cat /etc/passwd", purpose: "Checking disk usage" }, 1),
      toolResultEntry("c1", "execute", { text: "root:x:0:0:super-secret-line", body: { exitCode: 0 } }, 2),
    ];
    for (const mode of ["full", "brief"] as const) {
      const built = buildPlanFromActivity(entries, { mode });
      const json = JSON.stringify(built);
      assert.ok(!json.includes("/etc/passwd"));
      assert.ok(!json.includes("super-secret-line"));
    }
  });

  test("brief mode only emits public URLs that appear in replyText", () => {
    const entries = [
      toolCallEntry("c1", "web_search", { purpose: "Searching docs" }, 1),
      toolResultEntry(
        "c1",
        "web_search",
        {
          text: "See https://example.com/public and https://secret.internal/x and https://other.example.com/unmentioned",
        },
        2,
      ),
    ];
    const brief = buildPlanFromActivity(entries, {
      mode: "brief",
      replyText: "Found details at https://example.com/public.",
    });
    assert.deepEqual(
      brief.tasks[0]?.sources?.map((s) => s.url),
      ["https://example.com/public"],
    );
  });

  test("caps tasks at 49 distinct plus overflow summary under Slack's 50-task limit", () => {
    const entries = Array.from({ length: 55 }, (_, i) =>
      toolCallEntry(`c${i}`, "execute", { purpose: `Unique step ${i}` }, i + 1),
    );
    const built = buildPlanFromActivity(entries, { mode: "full" });
    assert.equal(built.tasks.length, 50);
    assert.ok(built.tasks.some((t) => t.title.includes("More steps")));
  });

  test("includes subagent branches as single tasks using branch.id", () => {
    const built = buildPlanFromActivity([], {
      mode: "full",
      branches: [{ id: "sub-1", title: "Helper", step: "Reading API guide" }],
    });
    assert.equal(built.tasks.length, 1);
    assert.equal(built.tasks[0]?.taskId, "qm_status:branch:sub-1");
    assert.ok(built.tasks[0]?.title.includes("Reading API guide"));
  });

  test("slackMessageContent preserves reply text and drops plan/task_card blocks", () => {
    const out = slackMessageContent({
      text: "Fallback text",
      blocks: [
        {
          type: "plan",
          block_id: "qm_status:plan:1",
          title: "Worked for 4s",
          tasks: [{ type: "task_card", task_id: "qm_status:step:1", title: "Checking status", status: "complete" }],
        },
        { type: "markdown", text: "Final answer here" },
      ],
    } as any);
    assert.ok(out.text.includes("Final answer here"));
    assert.ok(!out.text.includes("Worked for 4s"));
    assert.ok(!out.text.includes("Checking status"));
  });

  test("isOwnStatusCard census: status-only vs plan+reply, plan+image, non-status plan", () => {
    const statusPlan = {
      type: "plan",
      block_id: "qm_status:p1",
      title: "Working",
      tasks: [{ type: "task_card", task_id: "qm_status:s1", title: "Step", status: "in_progress" }],
    };
    assert.equal(isOwnStatusCard({ bot_id: "B1", blocks: [statusPlan] }, "U1", "B1"), true);
    assert.equal(
      isOwnStatusCard({ bot_id: "B1", blocks: [statusPlan, { type: "context", elements: [] }] }, "U1", "B1"),
      true,
    );
    assert.equal(
      isOwnStatusCard({ bot_id: "B1", blocks: [statusPlan, { type: "markdown", text: "Reply" }] }, "U1", "B1"),
      false,
    );
    assert.equal(
      isOwnStatusCard(
        { bot_id: "B1", blocks: [statusPlan, { type: "image", image_url: "https://example.com/a.png" }] },
        "U1",
        "B1",
      ),
      false,
    );
    assert.equal(
      isOwnStatusCard(
        { bot_id: "B1", blocks: [{ type: "plan", block_id: "other:p1", title: "Other", tasks: [] }] },
        "U1",
        "B1",
      ),
      false,
    );
  });
});

describe("slack thinking stream lifecycle", () => {
  async function setup(opts: Partial<ThinkingStreamOptions> = {}) {
    const store = testMap<SlackThinkingStreamRecord>();
    const runs = new Map<string, Run>();
    const activity = new Map<string, RunActivityEntry[]>();
    const editRefs: { runId: string; ref: string }[] = [];
    let t = 10_000;
    const client = makeFakeSlackClient();
    const stream = createSlackThinkingStream(
      store,
      createNoopLeaderLease(),
      { get: async (id) => runs.get(id) ?? null },
      { list: async (id) => activity.get(id) ?? [] },
      {
        now: () => t,
        reportEditRef: (runId, ref) => editRefs.push({ runId, ref }),
        minFlushIntervalMs: 0,
        ...opts,
      },
    );
    return {
      store,
      runs,
      activity,
      editRefs,
      client,
      stream,
      advance: (ms: number) => {
        t += ms;
      },
    };
  }

  test("does not open a stream for private or unthreaded turns", async () => {
    const f = await setup();
    f.runs.set("priv", makeRun({ id: "priv", request: { privateSessionMessage: true } as any }));
    f.runs.set("unthreaded", makeRun({ id: "unthreaded" }));
    assert.equal(
      await f.stream.registerTurn({
        account: "T1:B1",
        runId: "priv",
        sessionId: "s1",
        channel: "C1",
        threadTs: "100.1",
        detailMode: "full",
      }),
      false,
    );
    assert.equal(
      await f.stream.registerTurn({
        account: "T1:B1",
        runId: "unthreaded",
        sessionId: "s1",
        channel: "C1",
        detailMode: "full",
      }),
      false,
    );
    assert.equal(f.client.calls.length, 0);
  });

  test("ambient unprompted turns stay invisible until QM posts in thread", async () => {
    let posted = false;
    const f = await setup({ hasSurfacePosted: () => posted });
    f.runs.set("r1", makeRun({ id: "r1" }));
    f.activity.set("r1", [toolCallEntry("c1", "execute", { purpose: "Checking logs" })]);
    await f.stream.registerTurn({
      account: "T1:B1",
      runId: "r1",
      sessionId: "sess-1",
      channel: "C1",
      threadTs: "100.1",
      detailMode: "full",
      unprompted: true,
    });
    await f.stream.onActivity(f.client, "r1");
    assert.equal(f.client.calls.filter((c) => c.method === "chat.startStream").length, 0);

    posted = true;
    await f.stream.onActivity(f.client, "r1");
    assert.equal(f.client.calls.filter((c) => c.method === "chat.startStream").length, 1);
  });

  test("opens on first tool call, uses run.sessionId for generated title, streams updates, finalizes with markdown", async () => {
    let queriedSessionId: string | undefined;
    const f = await setup({
      getSessionTitle: async (sid) => {
        queriedSessionId = sid;
        return "Generated session title";
      },
    });
    f.runs.set("r1", makeRun({ id: "r1", sessionId: "real-session-uuid" }));
    f.activity.set("r1", [toolCallEntry("c1", "execute", { purpose: "Step one" }, 1)]);
    await f.stream.registerTurn({
      account: "T1:B1",
      runId: "r1",
      sessionId: "ch:C1:100.1",
      channel: "C1",
      threadTs: "100.1",
      detailMode: "full",
    });
    await f.stream.onActivity(f.client, "r1");

    assert.equal(queriedSessionId, "real-session-uuid");
    assert.ok(f.client.calls.some((c) => c.method === "chat.startStream"));
    assert.ok(
      f.client.calls.some((c) => c.method === "agents.sessions.rename" && c.args.title === "Generated session title"),
    );

    f.activity.set("r1", [
      toolCallEntry("c1", "execute", { purpose: "Step one" }, 1),
      toolResultEntry("c1", "execute", { body: { exitCode: 0 } }, 2),
    ]);
    await f.stream.onActivity(f.client, "r1");
    assert.ok(f.client.calls.some((c) => c.method === "chat.appendStream"));

    const res = await f.stream.deliver(f.client, {
      runId: "r1",
      channel: "C1",
      threadTs: "100.1",
      rawMarkdown: "All **done**.",
      finalize: true,
    });
    assert.equal(res.handled, true);
    assert.equal(res.messageTs, "200.1");
    assert.ok(f.client.calls.some((c) => c.method === "chat.stopStream"));
  });

  test("queues react/edit/delete while streaming and drains after stopStream", async () => {
    const f = await setup();
    f.runs.set("r1", makeRun({ id: "r1" }));
    f.activity.set("r1", [toolCallEntry("c1", "execute", { purpose: "Working" })]);
    await f.stream.registerTurn({
      account: "T1:B1",
      runId: "r1",
      sessionId: "sess-1",
      channel: "C1",
      threadTs: "100.1",
      detailMode: "full",
    });
    await f.stream.onActivity(f.client, "r1");
    assert.equal(await f.stream.queueIfStreaming("C1", "200.1", { kind: "react", emoji: "eyes" }), true);
    assert.equal(f.client.calls.filter((c) => c.method === "reactions.add").length, 0);

    await f.stream.deliver(f.client, {
      runId: "r1",
      channel: "C1",
      threadTs: "100.1",
      rawMarkdown: "Done",
      finalize: true,
    });
    assert.equal(f.client.calls.filter((c) => c.method === "reactions.add").length, 1);
  });

  test("9-minute rollover stops stream with processing status and switches to chat.update", async () => {
    const f = await setup({ rolloverMs: 5_000 });
    f.runs.set("r1", makeRun({ id: "r1" }));
    f.activity.set("r1", [toolCallEntry("c1", "execute", { purpose: "Long task" })]);
    await f.stream.registerTurn({
      account: "T1:B1",
      runId: "r1",
      sessionId: "sess-1",
      channel: "C1",
      threadTs: "100.1",
      detailMode: "full",
    });
    await f.stream.onActivity(f.client, "r1");

    f.advance(6_000);
    await f.stream.reconcile(f.client, "T1:B1");
    const stopCall = f.client.calls.find((c) => c.method === "chat.stopStream");
    assert.ok(stopCall);
    assert.equal(stopCall.args.session_status, "processing");
    assert.ok(f.client.calls.some((c) => c.method === "chat.update" && c.args.ts === "200.1"));
  });

  test("429 and non-429 startStream errors fall back cleanly to chat.postMessage", async () => {
    const f = await setup();
    f.client.failOn("chat.startStream", "ratelimited");
    f.runs.set("r1", makeRun({ id: "r1" }));
    f.activity.set("r1", [toolCallEntry("c1", "execute", { purpose: "Step 1" })]);
    await f.stream.registerTurn({
      account: "T1:B1",
      runId: "r1",
      sessionId: "sess-1",
      channel: "C1",
      threadTs: "100.1",
      detailMode: "full",
    });
    await f.stream.onActivity(f.client, "r1");
    assert.equal(f.client.calls.filter((c) => c.method === "chat.postMessage").length, 1);

    f.client.failOn("chat.startStream", "streaming_not_allowed");
    f.runs.set("r2", makeRun({ id: "r2" }));
    f.activity.set("r2", [toolCallEntry("c2", "execute", { purpose: "Step 2" })]);
    await f.stream.registerTurn({
      account: "T1:B1",
      runId: "r2",
      sessionId: "sess-1",
      channel: "C1",
      threadTs: "100.1",
      detailMode: "full",
    });
    await f.stream.onActivity(f.client, "r2");
    assert.equal(f.client.calls.filter((c) => c.method === "chat.postMessage").length, 2);
  });

  test("overflow delivery closes stream plan-only and returns closedStreamTs", async () => {
    const f = await setup();
    f.runs.set("r1", makeRun({ id: "r1" }));
    f.activity.set("r1", [toolCallEntry("c1", "execute", { purpose: "Step" })]);
    await f.stream.registerTurn({
      account: "T1:B1",
      runId: "r1",
      sessionId: "sess-1",
      channel: "C1",
      threadTs: "100.1",
      detailMode: "full",
    });
    await f.stream.onActivity(f.client, "r1");
    const res = await f.stream.deliver(f.client, {
      runId: "r1",
      channel: "C1",
      threadTs: "100.1",
      rawMarkdown: "x".repeat(12_000),
      finalize: true,
    });
    assert.equal(res.handled, false);
    assert.equal(res.closedStreamTs, "200.1");
  });

  test("silent turn deletes empty stream; stopped/failed with note delivers note into stream", async () => {
    const f = await setup();
    f.runs.set("r1", makeRun({ id: "r1" }));
    f.runs.set("r2", makeRun({ id: "r2" }));
    f.activity.set("r1", [toolCallEntry("c1", "execute", { purpose: "Step 1" })]);
    f.activity.set("r2", [toolCallEntry("c2", "execute", { purpose: "Step 2" })]);
    await f.stream.registerTurn({
      account: "T1:B1",
      runId: "r1",
      sessionId: "sess-1",
      channel: "C1",
      threadTs: "100.1",
      detailMode: "full",
    });
    await f.stream.registerTurn({
      account: "T1:B1",
      runId: "r2",
      sessionId: "sess-1",
      channel: "C1",
      threadTs: "100.1",
      detailMode: "full",
    });
    await f.stream.onActivity(f.client, "r1");
    await f.stream.onActivity(f.client, "r2");

    await f.stream.finishRun(f.client, "r1", { outcome: "silent" });
    assert.ok(f.client.calls.some((c) => c.method === "chat.delete" && c.args.ts === "200.1"));

    const handled = await f.stream.finishRun(f.client, "r2", { outcome: "stopped", note: "Stopped." });
    assert.equal(handled, true);
  });

  test("user title change prevents QM overwrite; awaiting_approval suspends; session_stopped stops stream", async () => {
    const f = await setup();
    f.runs.set("r1", makeRun({ id: "r1", sessionId: "sess-1" }));
    f.activity.set("r1", [toolCallEntry("c1", "execute", { purpose: "Step" })]);
    await f.stream.registerTurn({
      account: "T1:B1",
      runId: "r1",
      sessionId: "sess-1",
      channel: "C1",
      threadTs: "100.1",
      detailMode: "full",
    });
    await f.stream.onActivity(f.client, "r1");

    await f.stream.onSessionState(f.client, "T1:B1", "T1", { sessionId: "sess-1", state: "awaiting_approval" });
    assert.ok(f.client.calls.some((c) => c.method === "agents.sessions.setStatus" && c.args.status === "suspended"));

    await f.stream.handleSessionTitleChanged("T1:B1", "C1", "100.1");
    const renamesBefore = f.client.calls.filter((c) => c.method === "agents.sessions.rename").length;
    await f.stream.onSessionState(f.client, "T1:B1", "T1", {
      sessionId: "sess-1",
      state: "working",
      title: "Should not overwrite",
    });
    assert.equal(f.client.calls.filter((c) => c.method === "agents.sessions.rename").length, renamesBefore);

    await f.stream.handleSessionStopped(f.client, "T1:B1", "C1", "100.1");
    assert.ok(f.client.calls.some((c) => c.method === "chat.stopStream" && c.args.ts === "200.1"));
  });

  test("session-status defers in-turn card and draws waiting card as plan block", async () => {
    const store = testMap<SlackSessionStatusState>();
    let activeRun = true;
    let t = 10_000;
    const client = makeFakeSlackClient();
    const status = createSlackSessionStatus(
      store,
      createNoopLeaderLease(),
      {
        get: async (id) =>
          makeRun({
            id,
            status: activeRun ? "running" : "done",
            deliveryState: { replying: true },
          }),
      },
      () => t,
      {
        work: {
          of: async (): Promise<SessionWork> => ({
            busy: true,
            running: activeRun ? { purpose: "Working" } : undefined,
            branches: [{ id: "b1", title: "Background analysis", step: "Crunching numbers" }],
            returning: false,
            delivering: false,
          }),
        },
      },
    );

    await status.start(client, "T1:B1", "r1", "C1", "100.1");
    t += 5_000;
    await status.reconcile(client, "T1:B1");
    assert.equal(client.calls.filter((c) => c.method === "chat.postMessage").length, 0);

    activeRun = false;
    t += 5_000;
    await status.reconcile(client, "T1:B1");
    const post = client.calls.find((c) => c.method === "chat.postMessage");
    assert.ok(post);
    const blocks = post.args.blocks as { type: string }[];
    assert.equal(blocks[0]?.type, "plan");
  });

  test("planTitleForState formats working, done, stopped, failed, and rollover titles", () => {
    assert.equal(planTitleForState("working"), "Working…");
    assert.equal(planTitleForState("working", { currentStep: "Checking logs" }), "Working — Checking logs");
    assert.equal(planTitleForState("done", { elapsedMs: 12_000 }), "Worked for 12s");
    assert.equal(planTitleForState("stopped"), "Stopped");
    assert.equal(planTitleForState("failed"), "Stopped after an error");
    assert.equal(planTitleForState("rolled_over"), "Working… (continued below)");
  });
});
