import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  attachPendingApprovals,
  currentEarlierCount,
  entriesToMessages,
  forkOriginDetails,
  inheritedRefreshEntries,
  inheritedTranscript,
  loadInheritedTranscript,
  type AssistantWork,
  type PendingApproval,
  type SessionEntry,
} from "../src/core-bridge.ts";

test("fork provenance separates inherited entries at the boundary", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "old" }, createdAt: 1, seq: 1 },
    { type: "assistant", payload: { text: "copied" }, createdAt: 2, seq: 2 },
    { type: "user", payload: { text: "new" }, createdAt: 3, seq: 3 },
  ];
  const collapsed = inheritedTranscript(
    { forkedFrom: { sessionId: "source", title: "Original" }, forkBoundarySeq: 2 },
    entries,
  );
  assert.deepEqual(
    collapsed.inherited.map((entry) => entry.seq),
    [1, 2],
  );
  assert.deepEqual(
    collapsed.current.map((entry) => entry.seq),
    [3],
  );
  assert.deepEqual(inheritedTranscript({}, entries), { inherited: [], current: entries });
});

test("inherited transcript requires complete provenance and a defined entry sequence", () => {
  const sequenced = { type: "user", payload: { text: "old" }, createdAt: 1, seq: 2 } as SessionEntry;
  const unsequenced = { type: "assistant", payload: { text: "unknown" }, createdAt: 2 } as SessionEntry;
  assert.deepEqual(inheritedTranscript({ forkedFrom: { sessionId: "source" } }, [sequenced]), {
    inherited: [],
    current: [sequenced],
  });
  assert.deepEqual(inheritedTranscript({ forkBoundarySeq: 2 }, [sequenced]), {
    inherited: [],
    current: [sequenced],
  });
  assert.deepEqual(inheritedTranscript({ forkedFrom: { sessionId: "source" }, forkBoundarySeq: 2 }, [unsequenced]), {
    inherited: [],
    current: [unsequenced],
  });
});

test("inherited expansion pages backward to the start and preserves transcript order", async () => {
  const session = { id: "fork", forkedFrom: { sessionId: "source" }, forkBoundarySeq: 50 };
  const first = { type: "user", payload: { text: "first" }, createdAt: 1, seq: 1 } as SessionEntry;
  const middle = { type: "assistant", payload: { text: "middle" }, createdAt: 2, seq: 25 } as SessionEntry;
  const last = { type: "user", payload: { text: "last" }, createdAt: 3, seq: 50 } as SessionEntry;
  const calls: unknown[] = [];
  const fetcher = async (id: string, window?: { tailTurns?: number; beforeSeq?: number }) => {
    calls.push({ id, window });
    return window?.beforeSeq === 51
      ? { entries: [middle, last], earlierEntries: 1 }
      : { entries: [first], earlierEntries: 0 };
  };
  assert.deepEqual(await loadInheritedTranscript(session, [], fetcher), [first, middle, last]);
  assert.deepEqual(calls, [
    { id: "fork", window: { beforeSeq: 51, tailTurns: 25 } },
    { id: "fork", window: { beforeSeq: 25, tailTurns: 25 } },
  ]);
  calls.length = 0;
  assert.deepEqual(await loadInheritedTranscript(session, [last], fetcher), [last]);
  assert.deepEqual(calls, []);
});

test("inherited expansion reaches entry seq 0 (0-based sequences)", async () => {
  const session = { id: "fork", forkedFrom: { sessionId: "source" }, forkBoundarySeq: 2 };
  const pages: Record<number, { entries: SessionEntry[]; earlierEntries: number }> = {
    3: {
      entries: [{ type: "assistant", payload: { text: "two" }, createdAt: 3, seq: 2 } as SessionEntry],
      earlierEntries: 2,
    },
    2: {
      entries: [{ type: "user", payload: { text: "one" }, createdAt: 2, seq: 1 } as SessionEntry],
      earlierEntries: 1,
    },
    1: {
      entries: [{ type: "user", payload: { text: "zero" }, createdAt: 1, seq: 0 } as SessionEntry],
      earlierEntries: 0,
    },
  };
  const calls: number[] = [];
  const fetcher = async (_id: string, window?: { beforeSeq?: number }) => {
    calls.push(window?.beforeSeq ?? -1);
    return pages[window?.beforeSeq ?? -1]!;
  };
  const inherited = await loadInheritedTranscript(session, [], fetcher as never);
  assert.deepEqual(calls, [3, 2, 1]);
  assert.deepEqual(
    inherited.map((entry) => entry.seq),
    [0, 1, 2],
  );
});

test("currentEarlierCount hides inherited entries from the earlier-messages count", () => {
  const fork = { forkedFrom: { sessionId: "source" }, forkBoundarySeq: 4 };
  assert.equal(currentEarlierCount(fork, 12), 7);
  assert.equal(currentEarlierCount(fork, 5), 0);
  assert.equal(currentEarlierCount(fork, 3), 0);
  assert.equal(currentEarlierCount({}, 12), 12);
  assert.equal(currentEarlierCount({ forkedFrom: { sessionId: "source" } }, 12), 12);
});

test("a stale show load never lands on the next fork; reset revives the control", async () => {
  const dom = new JSDOM("<!doctype html><main></main>");
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Event", { configurable: true, value: dom.window.Event });
  const { createForkOriginController } = await import("../src/fork-origin.ts");
  const state = { inheritedMessages: [] as SessionEntry[], inheritedLoaded: false, inheritedExpanded: false };
  const pending: Array<(entries: SessionEntry[]) => void> = [];
  const controller = createForkOriginController<SessionEntry>({
    state,
    load: () => new Promise((resolve) => pending.push(resolve)),
    navigate: async () => {},
    current: () => true,
    redraw: () => {},
    setError: () => {},
  });
  const firstToggle = controller.toggle();
  assert.equal(pending.length, 1);
  controller.reset(); // switched to another fork mid-load
  const secondToggle = controller.toggle(); // new fork's control is live immediately
  assert.equal(pending.length, 2, "reset frees the in-flight guard");
  pending[0]!([{ type: "user", payload: { text: "fork A history" }, createdAt: 1, seq: 0 } as SessionEntry]);
  await firstToggle;
  assert.equal(state.inheritedLoaded, false, "stale load is discarded");
  assert.equal(state.inheritedMessages.length, 0, "stale load is discarded");
  pending[1]!([{ type: "user", payload: { text: "fork B history" }, createdAt: 2, seq: 0 } as SessionEntry]);
  await secondToggle;
  assert.equal(state.inheritedLoaded, true);
  assert.equal(state.inheritedExpanded, true);
  assert.equal((state.inheritedMessages[0]!.payload as { text: string }).text, "fork B history");
});

test("a failed show load surfaces an error instead of dying silently", async () => {
  const { createForkOriginController } = await import("../src/fork-origin.ts");
  const state = { inheritedMessages: [] as SessionEntry[], inheritedLoaded: false, inheritedExpanded: false };
  let error = "";
  let redraws = 0;
  const controller = createForkOriginController<SessionEntry>({
    state,
    load: () => Promise.reject(new Error("boom")),
    navigate: async () => {},
    current: () => true,
    redraw: () => {
      redraws++;
    },
    setError: (value) => {
      error = value;
    },
  });
  await controller.toggle();
  assert.equal(error, "Couldn't load the original conversation's history.");
  assert.ok(redraws >= 1);
  assert.equal(state.inheritedExpanded, false, "a failed load never expands");
  assert.equal(state.inheritedLoaded, false);
  // the control recovers: a later successful load works
  const ok = createForkOriginController<SessionEntry>({
    state,
    load: async () => [{ type: "user", payload: { text: "old" }, createdAt: 1, seq: 0 } as SessionEntry],
    navigate: async () => {},
    current: () => true,
    redraw: () => {},
    setError: () => {},
  });
  await ok.toggle();
  assert.equal(state.inheritedLoaded, true);
  assert.equal(state.inheritedExpanded, true);
});

test("a successful show clears a prior error; an in-flight load survives non-reset redraws", async () => {
  const { createForkOriginController } = await import("../src/fork-origin.ts");
  const state = { inheritedMessages: [] as SessionEntry[], inheritedLoaded: false, inheritedExpanded: false };
  let error = "sticky old failure";
  let resolveLoad: ((entries: SessionEntry[]) => void) | null = null;
  const controller = createForkOriginController<SessionEntry>({
    state,
    load: () => new Promise((resolve) => (resolveLoad = resolve)),
    navigate: async () => {},
    current: () => true,
    redraw: () => {},
    setError: (value) => {
      error = value;
    },
  });
  const toggling = controller.toggle();
  assert.equal(error, "", "starting a new attempt clears the stale error");
  // a same-session remount does NOT reset the controller, so the load lands
  resolveLoad!([{ type: "user", payload: { text: "old" }, createdAt: 1, seq: 0 } as SessionEntry]);
  await toggling;
  assert.equal(state.inheritedLoaded, true);
  assert.equal(state.inheritedExpanded, true);
  assert.equal(error, "", "no error after a successful show");
});

test("fork origin remains visible when a deep-link tail contains only post-fork entries", () => {
  const session = { forkedFrom: { sessionId: "source", title: "Original" }, forkBoundarySeq: 10 };
  const postForkTail = Array.from({ length: 25 }, (_, index) => ({
    type: "user" as const,
    payload: { text: String(index) },
    createdAt: index,
    seq: 11 + index,
  }));
  assert.equal(inheritedTranscript(session, postForkTail).inherited.length, 0);
  assert.deepEqual(forkOriginDetails(session, 0), { sessionId: "source", title: "Original" });
  assert.deepEqual(forkOriginDetails(session, 3), {
    sessionId: "source",
    title: "Original",
    messageCount: 3,
  });
});

test("fork origin DOM navigates, reports access failure once, pages, toggles, survives refresh, and resets", async () => {
  const dom = new JSDOM('<!doctype html><main id="chat"></main>');
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Event", { configurable: true, value: dom.window.Event });
  const [{ render }, { createForkOriginController, forkOriginView }] = await Promise.all([
    import("lit"),
    import("../src/fork-origin.ts"),
  ]);
  const host = dom.window.document.querySelector<HTMLElement>("#chat")!;
  const session = {
    id: "fork",
    forkedFrom: { sessionId: "source", title: "Original" },
    forkBoundarySeq: 2,
  };
  const state = { inheritedMessages: [] as SessionEntry[], inheritedLoaded: false, inheritedExpanded: false };
  let error = "";
  let navigationFails = false;
  let navigations = 0;
  const calls: number[] = [];
  const fetcher = async (_id: string, window?: { beforeSeq?: number }) => {
    calls.push(window?.beforeSeq ?? 0);
    return window?.beforeSeq === 3
      ? {
          entries: [{ type: "assistant" as const, payload: { text: "old two" }, createdAt: 2, seq: 2 }],
          earlierEntries: 1,
        }
      : {
          entries: [{ type: "user" as const, payload: { text: "old one" }, createdAt: 1, seq: 1 }],
          earlierEntries: 0,
        };
  };
  const controller = createForkOriginController({
    state,
    load: () => loadInheritedTranscript(session, [], fetcher as never),
    navigate: async () => {
      navigations++;
      if (navigationFails) throw new Error("denied");
    },
    current: () => true,
    redraw: () => draw(),
    setError: (value) => {
      error = value;
    },
  });
  const draw = () => {
    for (const node of host.querySelectorAll("article")) node.remove();
    const origin = forkOriginDetails(session, state.inheritedLoaded ? state.inheritedMessages.length : 0);
    render(
      origin
        ? forkOriginView({
            ...origin,
            expanded: state.inheritedExpanded,
            navigate: () => void controller.navigate(),
            toggle: () => void controller.toggle(),
          })
        : null,
      host,
    );
    const existing = host.querySelector(".composer-error");
    existing?.remove();
    if (error) {
      const node = dom.window.document.createElement("div");
      node.className = "composer-error";
      node.textContent = error;
      host.append(node);
    }
    if (state.inheritedExpanded)
      for (const entry of state.inheritedMessages) {
        const node = dom.window.document.createElement("article");
        node.textContent = (entry.payload as { text: string }).text;
        host.append(node);
      }
  };
  draw();
  assert.match(host.textContent ?? "", /Forked from Original/);
  assert.doesNotMatch(host.textContent ?? "", /messages/);
  host.querySelector<HTMLButtonElement>(".fork-origin-badge")!.click();
  assert.equal(navigations, 1);
  navigationFails = true;
  host.querySelector<HTMLButtonElement>(".fork-origin-badge")!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(host.textContent?.match(/You no longer have access to the original conversation\./g)?.length, 1);
  controller.reset();
  draw();
  assert.doesNotMatch(host.textContent ?? "", /no longer have access/);
  host.querySelector<HTMLButtonElement>(".fork-origin-toggle")!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [3, 2]);
  assert.match(host.textContent ?? "", /old one/);
  assert.match(host.textContent ?? "", /old two/);
  assert.match(host.textContent ?? "", /2 messages/);
  host.querySelector<HTMLButtonElement>(".fork-origin-toggle")!.click();
  assert.doesNotMatch(host.textContent ?? "", /old one/);
  const staleGeneration = controller.beginRefresh();
  const generation = controller.beginRefresh();
  const refresh = inheritedRefreshEntries(
    session,
    [{ type: "assistant", payload: { text: "new reply" }, createdAt: 3, seq: 3 }],
    state.inheritedLoaded,
  );
  assert.equal(controller.applyRefresh(generation, refresh), true);
  assert.equal(
    controller.applyRefresh(staleGeneration, [{ type: "user", payload: { text: "stale" }, createdAt: 0, seq: 1 }]),
    false,
  );
  host.querySelector<HTMLButtonElement>(".fork-origin-toggle")!.click();
  assert.match(host.textContent ?? "", /old one/);
  assert.equal(host.textContent?.match(/old one/g)?.length, 1);
  const noOrigin = forkOriginDetails({}, 0);
  render(noOrigin ? forkOriginView({ ...noOrigin, expanded: false, navigate() {}, toggle() {} }) : null, host);
  assert.equal(host.querySelector(".fork-origin-badge"), null);
  dom.window.close();
});

const MODEL = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Parameters<
  typeof entriesToMessages
>[1];

test("tool entries are folded into the following assistant reply's work block", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "hi" }, createdAt: 100 },
    { type: "tool_call", payload: { tool: "execute", command: "ls" }, createdAt: 110, seq: 2, parentSeq: 1 },
    {
      type: "tool_result",
      payload: { tool: "execute", code: 0, stdout: "a\nb" },
      createdAt: 120,
      seq: 3,
      parentSeq: 2,
    },
    { type: "assistant", payload: { text: "done" }, createdAt: 130 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  assert.equal(msgs.length, 2, "user + assistant");
  const work = (msgs[1] as AssistantWork).work;
  assert.ok(work, "the assistant reply carries a work block");
  assert.equal(work?.status, "complete");
  assert.equal(work?.startedAt, 110, "work starts at the first tool step");
  assert.equal(work?.finishedAt, 130, "work ends at the assistant reply");
  assert.deepEqual(
    work?.activity.map((a) => a.type),
    ["tool_call", "tool_result"],
  );
});

test("a hidden proactive-opener user entry never renders, but its assistant greeting does", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "open the conversation", hidden: true }, createdAt: 100 },
    { type: "assistant", payload: { text: "Hi — I'm your AI teammate 👋" }, createdAt: 110 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  assert.equal(msgs.length, 1, "only the greeting, never the opener seed");
  assert.equal((msgs[0] as { role?: string }).role, "assistant");
});

test("a durable turn_failure entry renders like the live inline error (survives reload)", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "how did it go?" }, createdAt: 100 },
    {
      type: "system",
      payload: { kind: "turn_failure", message: "API integrators: you can reduce refusals…" },
      createdAt: 110,
    },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  assert.equal(msgs.length, 2, "user + error");
  const err = msgs[1] as { role?: string; stopReason?: string; errorMessage?: string };
  assert.equal(err.role, "assistant");
  assert.equal(err.stopReason, "error");
  assert.equal(err.errorMessage, "API integrators: you can reduce refusals…");
});

test("other system entries (file events, context summaries) still never render", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "hi" }, createdAt: 100 },
    { type: "system", payload: { kind: "file_event", text: "Files received…" }, createdAt: 105 },
    { type: "system", payload: { kind: "context_summary", throughSeq: 1, text: "summary" }, createdAt: 106 },
    { type: "assistant", payload: { text: "hello" }, createdAt: 110 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  assert.equal(msgs.length, 2, "user + assistant only");
});

test("a turn with no tool entries gets no work block (plain markdown, prior behavior)", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "again" }, createdAt: 200 },
    { type: "assistant", payload: { text: "plain" }, createdAt: 210 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  assert.equal((msgs[1] as AssistantWork).work, undefined);
});

test("user attachments survive the reload rebuild — image with text keeps a renderable attachment", () => {
  const entries: SessionEntry[] = [
    {
      type: "user",
      payload: {
        text: "look at this",
        attachments: [
          { name: "shot.png", mimetype: "image/png", sizeBytes: 116526, direction: "in", artifactId: "art-9" },
        ],
      },
      createdAt: 100,
      seq: 1,
    },
    { type: "assistant", payload: { text: "Looking." }, createdAt: 110 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  const user = msgs[0] as { role?: string; content?: string; attachments?: Array<Record<string, unknown>> };
  assert.equal(user.role, "user");
  assert.equal(user.content, "look at this", "the text stays the bubble text");
  assert.deepEqual(user.attachments, [
    { id: "art-9", type: "image", fileName: "shot.png", mimeType: "image/png", size: 116526, artifactId: "art-9" },
  ]);
});

test("an attachment-only user entry rebuilds as a real user message with attachments, not a \u{1F4CE} text line", () => {
  const entries: SessionEntry[] = [
    {
      type: "user",
      payload: {
        text: "",
        attachments: [{ name: "cat.png", mimetype: "image/png", sizeBytes: 5, direction: "in", artifactId: "art-1" }],
      },
      createdAt: 100,
      seq: 1,
    },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  assert.equal(msgs.length, 1);
  const user = msgs[0] as { content?: string; attachments?: Array<{ fileName?: string }> };
  assert.equal(user.content, "", "no synthetic emoji line");
  assert.equal(user.attachments?.[0]?.fileName, "cat.png");
});

test("a legacy user entry without artifactId keeps a metadata-only attachment (chip fallback)", () => {
  const entries: SessionEntry[] = [
    {
      type: "user",
      payload: {
        text: "old one",
        attachments: [{ name: "doc.pdf", mimetype: "application/pdf", sizeBytes: 9, direction: "in" }],
      },
      createdAt: 100,
      seq: 3,
    },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  const att = (msgs[0] as { attachments?: Array<Record<string, unknown>> }).attachments?.[0];
  assert.ok(att, "attachment survives");
  assert.equal(att!.type, "document");
  assert.equal(att!.artifactId, undefined, "no fabricated artifact link");
});

test("delivery entries attach openable files to the preceding assistant message", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "make gifs" }, createdAt: 100 },
    { type: "assistant", payload: { text: "Here are the gifs." }, createdAt: 120 },
    {
      type: "delivery",
      payload: {
        text: "rsi.gif",
        files: [{ name: "rsi.gif", mimetype: "image/gif", sizeBytes: 42, artifactId: "art-1" }],
      },
      createdAt: 121,
    },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  assert.equal(msgs.length, 2);
  assert.deepEqual((msgs[1] as AssistantWork).deliveredFiles, [
    { name: "rsi.gif", mimetype: "image/gif", sizeBytes: 42, artifactId: "art-1" },
  ]);
});

test("delivery-only turns still rebuild an assistant message for the file chips", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "make gif only" }, createdAt: 100 },
    {
      type: "delivery",
      payload: {
        text: "rsi.gif",
        files: [{ name: "rsi.gif", mimetype: "image/gif", sizeBytes: 42, artifactId: "art-1" }],
      },
      createdAt: 121,
    },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  assert.equal(msgs.length, 2);
  assert.equal((msgs[1] as { role?: string }).role, "assistant");
  assert.equal(((msgs[1] as AssistantWork).content[0] as { text?: string }).text, "");
  assert.deepEqual((msgs[1] as AssistantWork).deliveredFiles, [
    { name: "rsi.gif", mimetype: "image/gif", sizeBytes: 42, artifactId: "art-1" },
  ]);
});

test("tool entries from a prior turn don't leak into the next turn's assistant reply", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "one" }, createdAt: 100 },
    { type: "tool_call", payload: { tool: "read", path: "/x" }, createdAt: 110, seq: 2, parentSeq: 1 },
    { type: "user", payload: { text: "two" }, createdAt: 200 },
    { type: "assistant", payload: { text: "answer" }, createdAt: 210 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  const last = msgs[msgs.length - 1] as AssistantWork;
  assert.equal(last.work, undefined, "the second turn's reply carries none of the first turn's activity");
  assert.ok(msgs.some((m) => (m as AssistantWork).work?.activity.some((a) => a.type === "tool_call")));
});

test("a turn paused mid-stream (no closing assistant entry) flushes its activity into a work block", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "do it" }, createdAt: 100 },
    { type: "tool_call", payload: { tool: "execute", command: "rm -rf x" }, createdAt: 110, seq: 2, parentSeq: 1 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  assert.equal(msgs.length, 2, "user + a synthetic assistant holding the paused activity");
  const work = (msgs[1] as AssistantWork).work;
  assert.ok(work, "trailing tool activity is not dropped");
  assert.deepEqual(
    work?.activity.map((a) => a.type),
    ["tool_call"],
  );
});

test("attachPendingApprovals hangs approvals on the trailing assistant turn after reload", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "do it" }, createdAt: 100 },
    { type: "tool_call", payload: { tool: "execute", command: "deploy" }, createdAt: 110, seq: 2, parentSeq: 1 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  const approvals: PendingApproval[] = [{ requestId: "r1", command: "deploy", reason: "needs ok" }];
  attachPendingApprovals(msgs, approvals, MODEL);
  assert.deepEqual((msgs[msgs.length - 1] as AssistantWork).work?.pendingApprovals, approvals);
});

test("attachPendingApprovals anchors a stale approval to its own turn, not the latest one", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "do it" }, createdAt: 100 },
    { type: "tool_call", payload: { tool: "execute", command: "deploy" }, createdAt: 110, seq: 2, parentSeq: 1 },
    { type: "user", payload: { text: "actually, nvm — what time is it?" }, createdAt: 200 },
    { type: "assistant", payload: { text: "It's noon." }, createdAt: 210 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  const before = msgs.length;
  const approvals: PendingApproval[] = [{ requestId: "r1", command: "deploy", reason: "needs ok" }];
  attachPendingApprovals(msgs, approvals, MODEL);
  assert.equal(msgs.length, before, "no synthetic turn is appended");
  const deployTurn = msgs.find((m) =>
    (m as AssistantWork).work?.activity.some((a) => a.type === "tool_call"),
  ) as AssistantWork;
  assert.deepEqual(deployTurn.work?.pendingApprovals, approvals, "buttons hang on the deploy turn");
  assert.equal((msgs[msgs.length - 1] as AssistantWork).work?.pendingApprovals, undefined, "not on the latest turn");
});

test("attachPendingApprovals attaches to a completed turn that carries the paused command (ok + pendingApprovals)", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "deploy it in the background" }, createdAt: 100 },
    { type: "tool_call", payload: { tool: "execute", command: "deploy" }, createdAt: 110, seq: 2, parentSeq: 1 },
    { type: "assistant", payload: { text: "Kicking that off." }, createdAt: 120 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  const approvals: PendingApproval[] = [{ requestId: "r1", command: "deploy", reason: "needs ok" }];
  attachPendingApprovals(msgs, approvals, MODEL);
  assert.deepEqual((msgs[msgs.length - 1] as AssistantWork).work?.pendingApprovals, approvals);
});

test("attachPendingApprovals with no outstanding approvals leaves the transcript untouched", () => {
  const msgs: AgentMessage[] = [{ role: "user", content: "hi", timestamp: 1 } as AgentMessage];
  attachPendingApprovals(msgs, [], MODEL);
  assert.equal(msgs.length, 1);
});

test("attachPendingApprovals appends an assistant turn when the transcript ends on the user", () => {
  const msgs = entriesToMessages([{ type: "user", payload: { text: "approve please" }, createdAt: 100 }], MODEL);
  const approvals: PendingApproval[] = [{ requestId: "r1", command: "deploy" }];
  attachPendingApprovals(msgs, approvals, MODEL);
  const last = msgs[msgs.length - 1] as AssistantWork;
  assert.equal(last.role, "assistant");
  assert.deepEqual(last.work?.pendingApprovals, approvals);
});

test("thinking entries are interleaved into the work block by seq (reload path)", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "do it" }, createdAt: 100, seq: 1 },
    { type: "thinking", payload: { thinking: "let me look" }, createdAt: 110, seq: 2, parentSeq: 1 },
    { type: "tool_call", payload: { tool: "execute", command: "ls" }, createdAt: 120, seq: 3, parentSeq: 2 },
    { type: "tool_result", payload: { tool: "execute", code: 0 }, createdAt: 130, seq: 4, parentSeq: 3 },
    { type: "thinking", payload: { thinking: "", redacted: true }, createdAt: 135, seq: 5, parentSeq: 1 },
    { type: "assistant", payload: { text: "done" }, createdAt: 140, seq: 6 },
  ];
  const work = (entriesToMessages(entries, MODEL)[1] as AssistantWork).work;
  assert.deepEqual(
    work?.activity.map((a) => a.type),
    ["thinking", "tool_call", "tool_result"],
    "renderable thinking is kept in seq order; the redacted (empty) thinking is dropped",
  );
});

test("interstitial text entries fold into the work timeline; the final reply stays separate", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "go" }, createdAt: 100, seq: 1 },
    { type: "text", payload: { text: "Looking now." }, createdAt: 110, seq: 2, parentSeq: 1 },
    { type: "tool_call", payload: { tool: "execute", command: "ls" }, createdAt: 120, seq: 3, parentSeq: 2 },
    { type: "tool_result", payload: { tool: "execute", code: 0 }, createdAt: 130, seq: 4, parentSeq: 3 },
    { type: "assistant", payload: { text: "All set." }, createdAt: 140, seq: 5 },
  ];
  const msg = entriesToMessages(entries, MODEL)[1] as AssistantWork;
  assert.deepEqual(
    msg.work?.activity.map((a) => a.type),
    ["text", "tool_call", "tool_result"],
    "narration is woven into the work block in seq order",
  );
  assert.equal(
    (msg.content[0] as { text: string }).text,
    "All set.",
    "the final reply is the assistant entry, not a text segment",
  );
});

test("a turn ending on a tool-call step doesn't duplicate its narration (reply == last text)", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "delete it" }, createdAt: 100, seq: 1 },
    { type: "text", payload: { text: "Deleting now." }, createdAt: 110, seq: 2, parentSeq: 1 },
    { type: "tool_call", payload: { tool: "execute", command: "rm -rf x" }, createdAt: 120, seq: 3, parentSeq: 2 },
    {
      type: "tool_result",
      payload: { tool: "execute", blocked: "needs_approval" },
      createdAt: 130,
      seq: 4,
      parentSeq: 3,
    },
    { type: "assistant", payload: { text: "Deleting now." }, createdAt: 140, seq: 5 },
  ];
  const msg = entriesToMessages(entries, MODEL)[1] as AssistantWork;
  assert.deepEqual(
    msg.work?.activity.map((a) => a.type),
    ["tool_call", "tool_result"],
    "the duplicated narration segment is dropped from the work block",
  );
  assert.equal((msg.content[0] as { text: string }).text, "Deleting now.", "it shows once, as the reply");
});

test("a wake-wrapped user entry renders its display text, never the raw envelope", () => {
  const entries: SessionEntry[] = [
    {
      type: "user",
      payload: {
        text: '<wake reason="addressed" surface="web"><addressed-messages>…</addressed-messages></wake>',
        display: "Do you have any policies around sensitive data?",
        name: "carol",
      },
      createdAt: 100,
      seq: 0,
    },
    { type: "assistant", payload: { text: "done" }, createdAt: 130, seq: 1 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  assert.equal((msgs[0] as { content?: string }).content, "Do you have any policies around sensitive data?");
  assert.ok(!JSON.stringify(msgs).includes("<wake"), "the envelope never reaches the transcript");
});

test("a surface post renders as the reply bubble; the closing self-log demotes to work narration", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "<wake…>", display: "any policies?" }, createdAt: 100, seq: 0 },
    { type: "thinking", payload: { thinking: "I should summarize the policies." }, createdAt: 105, seq: 1 },
    {
      type: "tool_call",
      payload: {
        tool: "web",
        action: "post",
        text: "Yes — conversation boundaries, credentials, least access.",
        callId: "c1",
      },
      createdAt: 110,
      seq: 2,
      parentSeq: 0,
    },
    {
      type: "tool_result",
      payload: { tool: "web", action: "post", ok: true, callId: "c1", isError: false, result: "[sent]" },
      createdAt: 120,
      seq: 3,
      parentSeq: 2,
    },
    { type: "assistant", payload: { text: "Replied in thread with a policy summary." }, createdAt: 130, seq: 4 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  assert.equal(msgs.length, 3, "user + post reply + demoted-log work block");
  const reply = msgs[1] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(reply.role, "assistant");
  assert.equal(reply.content[0]?.text, "Yes — conversation boundaries, credentials, least access.");
  assert.ok(
    !JSON.stringify(reply.work?.activity ?? []).includes('"tool_call"'),
    "the post call folds into the bubble, not a work row",
  );
  const trailer = msgs[2] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(trailer.content[0]?.text ?? "", "", "the self-log is not a reply bubble");
  assert.ok(
    JSON.stringify(trailer.work?.activity ?? []).includes("Replied in thread"),
    "the self-log survives as work narration",
  );
});

test("a legacy bytes-only post entry keeps the old rendering (work row + closing text as reply)", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "hi" }, createdAt: 100, seq: 0 },
    {
      type: "tool_call",
      payload: { tool: "web", action: "post", bytes: 873, callId: "c1" },
      createdAt: 110,
      seq: 2,
      parentSeq: 0,
    },
    {
      type: "tool_result",
      payload: { tool: "web", action: "post", ok: true, callId: "c1", isError: false, result: "[sent]" },
      createdAt: 120,
      seq: 3,
      parentSeq: 2,
    },
    { type: "assistant", payload: { text: "Replied in thread." }, createdAt: 130, seq: 4 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  assert.equal(msgs.length, 2);
  const reply = msgs[1] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(reply.content[0]?.text, "Replied in thread.");
  assert.deepEqual(
    reply.work?.activity.map((a) => a.type),
    ["tool_call", "tool_result"],
  );
});

test("a failed text-less post (missing_text) stays visible as a failed work row", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "hi" }, createdAt: 100, seq: 0 },
    {
      type: "tool_result",
      payload: {
        tool: "web",
        action: "post",
        error: "missing_text",
        callId: "c2",
        isError: true,
        result: '[error] the "post" action requires `text`.',
      },
      createdAt: 140,
      seq: 5,
    },
    {
      type: "tool_call",
      payload: { tool: "web", action: "post", text: "second try", callId: "c3" },
      createdAt: 150,
      seq: 6,
    },
    {
      type: "tool_result",
      payload: { tool: "web", action: "post", ok: true, callId: "c3", isError: false, result: "[sent]" },
      createdAt: 160,
      seq: 7,
    },
    { type: "assistant", payload: { text: "Recovered and replied." }, createdAt: 170, seq: 8 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  const reply = msgs[1] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(reply.content[0]?.text, "second try");
  assert.ok(
    JSON.stringify(reply.work?.activity ?? []).includes("missing_text"),
    "the failed attempt still shows in the timeline",
  );
});

test("a FAILED post never renders as a delivered reply — its rows stay in the work timeline and the closing text stays the reply", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "hi" }, createdAt: 100, seq: 0 },
    {
      type: "tool_call",
      payload: { tool: "web", action: "post", text: "undelivered answer", callId: "c1" },
      createdAt: 110,
      seq: 1,
    },
    {
      type: "tool_result",
      payload: {
        tool: "web",
        action: "post",
        ok: false,
        callId: "c1",
        isError: true,
        result: "[not sent] delivery failed",
      },
      createdAt: 120,
      seq: 2,
    },
    {
      type: "assistant",
      payload: { text: "I couldn't deliver that reply — the send failed." },
      createdAt: 130,
      seq: 3,
    },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  assert.equal(msgs.length, 2);
  const reply = msgs[1] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(
    reply.content[0]?.text,
    "I couldn't deliver that reply — the send failed.",
    "the agent's explanation stays the visible reply",
  );
  assert.ok(JSON.stringify(reply.work?.activity ?? []).includes("[not sent]"), "the failure row stays visible");
});

test("an interrupted post (no result) renders as a work row, not a sent bubble", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "hi" }, createdAt: 100, seq: 0 },
    {
      type: "tool_call",
      payload: { tool: "web", action: "post", text: "maybe sent", callId: "c1" },
      createdAt: 110,
      seq: 1,
    },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  assert.equal(msgs.length, 2);
  const trailer = msgs[1] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(trailer.content[0]?.text ?? "", "", "no bubble claims the text was delivered");
  assert.ok(JSON.stringify(trailer.work?.activity ?? []).includes("maybe sent"), "the call is still visible as work");
});

test("a posted turn that closes empty is NOT promoted — the post bubble is already the reply", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "<wake…>", display: "any policies?" }, createdAt: 100, seq: 0 },
    {
      type: "tool_call",
      payload: { tool: "web", action: "post", text: "Yes — three of them.", callId: "c1" },
      createdAt: 110,
      seq: 1,
      parentSeq: 0,
    },
    {
      type: "tool_result",
      payload: { tool: "web", action: "post", ok: true, callId: "c1", isError: false, result: "[sent]" },
      createdAt: 120,
      seq: 2,
      parentSeq: 1,
    },
    { type: "text", payload: { text: "Logged the summary for follow-up." }, createdAt: 130, seq: 3, parentSeq: 0 },
    { type: "tool_call", payload: { tool: "execute", command: "echo done" }, createdAt: 140, seq: 4, parentSeq: 3 },
    { type: "tool_result", payload: { tool: "execute", code: 0 }, createdAt: 150, seq: 5, parentSeq: 4 },
    { type: "assistant", payload: { text: "" }, createdAt: 160, seq: 6 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  const reply = msgs[1] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(reply.content[0]?.text, "Yes — three of them.", "the delivered post stays the reply");
  const trailer = msgs[2] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(trailer.content[0]?.text ?? "", "", "trailing narration is not promoted into a second reply bubble");
  assert.ok(
    JSON.stringify(trailer.work?.activity ?? []).includes("Logged the summary"),
    "the narration survives as work",
  );
});

test("a turn that closed empty after narrating surfaces the last narration as the reply", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "[background job update] fetch done", hidden: true }, createdAt: 100, seq: 1 },
    {
      type: "text",
      payload: { text: "All benign — building the replay harness." },
      createdAt: 110,
      seq: 2,
      parentSeq: 1,
    },
    {
      type: "tool_call",
      payload: { tool: "execute", command: "node replay.js" },
      createdAt: 120,
      seq: 3,
      parentSeq: 2,
    },
    { type: "tool_result", payload: { tool: "execute", code: 0 }, createdAt: 130, seq: 4, parentSeq: 3 },
    {
      type: "text",
      payload: { text: "Server.js is nearly true — 8 bad lines. Applying the fixes." },
      createdAt: 140,
      seq: 5,
      parentSeq: 1,
    },
    { type: "tool_call", payload: { tool: "execute", command: "node apply.js" }, createdAt: 150, seq: 6, parentSeq: 5 },
    { type: "tool_result", payload: { tool: "execute", code: 0 }, createdAt: 160, seq: 7, parentSeq: 6 },
    { type: "assistant", payload: { text: "" }, createdAt: 170, seq: 8 },
  ];
  const msg = entriesToMessages(entries, MODEL)[0] as AssistantWork;
  assert.equal(
    (msg.content[0] as { text: string }).text,
    "Server.js is nearly true — 8 bad lines. Applying the fixes.",
    "the last narration becomes the visible reply instead of a bare tool-call count",
  );
  assert.deepEqual(
    msg.work?.activity.map((a) => a.type),
    ["text", "tool_call", "tool_result", "tool_call", "tool_result"],
    "the promoted segment moves out of the work block; earlier narration stays",
  );
});

test("a delivered-silence turn (finish_silently → silent:true) stays collapsed — no promotion", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "[background job update] still running", hidden: true }, createdAt: 100, seq: 1 },
    { type: "text", payload: { text: "Heartbeat check." }, createdAt: 110, seq: 2, parentSeq: 1 },
    {
      type: "tool_call",
      payload: { tool: "finish_silently", reason: "nothing new" },
      createdAt: 120,
      seq: 3,
      parentSeq: 2,
    },
    { type: "tool_result", payload: { tool: "finish_silently", silent: true }, createdAt: 130, seq: 4, parentSeq: 3 },
    { type: "assistant", payload: { text: "" }, createdAt: 140, seq: 5 },
  ];
  const msg = entriesToMessages(entries, MODEL)[0] as AssistantWork;
  assert.equal((msg.content[0] as { text: string }).text, "", "intentional silence is not turned into a message");
  assert.deepEqual(
    msg.work?.activity.map((a) => a.type),
    ["text", "tool_call", "tool_result"],
  );
});

test("a no-op finish_silently (non-poll, no silent:true) does NOT suppress promotion", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "do it" }, createdAt: 100, seq: 1 },
    { type: "tool_call", payload: { tool: "finish_silently" }, createdAt: 110, seq: 2, parentSeq: 1 },
    {
      type: "tool_result",
      payload: { tool: "finish_silently", noop: "not_a_poll_fire" },
      createdAt: 120,
      seq: 3,
      parentSeq: 2,
    },
    { type: "text", payload: { text: "Actually, here's the result." }, createdAt: 130, seq: 4, parentSeq: 1 },
    { type: "tool_call", payload: { tool: "execute", command: "ls" }, createdAt: 140, seq: 5, parentSeq: 4 },
    { type: "tool_result", payload: { tool: "execute", code: 0 }, createdAt: 150, seq: 6, parentSeq: 5 },
    { type: "assistant", payload: { text: "" }, createdAt: 160, seq: 7 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  const msg = msgs[msgs.length - 1] as AssistantWork;
  assert.equal(
    (msg.content[0] as { text: string }).text,
    "Actually, here's the result.",
    "a no-op silence call is not real silence",
  );
});

test("an explicit stay_silent decline stays collapsed — narration is not promoted", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "<wake…>", display: "fyi thread" }, createdAt: 100, seq: 1 },
    { type: "text", payload: { text: "Not my place to weigh in here." }, createdAt: 110, seq: 2, parentSeq: 1 },
    {
      type: "tool_call",
      payload: { tool: "stay_silent", reason: "not addressed to me" },
      createdAt: 120,
      seq: 3,
      parentSeq: 2,
    },
    { type: "tool_result", payload: { tool: "stay_silent", ok: true }, createdAt: 130, seq: 4, parentSeq: 3 },
    { type: "assistant", payload: { text: "" }, createdAt: 140, seq: 5 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  const msg = msgs[msgs.length - 1] as AssistantWork;
  assert.equal(
    (msg.content[0] as { text: string }).text,
    "",
    "a deliberate decline is not turned into a visible message",
  );
});

test("posted state does not leak across a hidden turn boundary — the next turn's reply stays visible", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "<wake…>", display: "any policies?" }, createdAt: 100, seq: 1 },
    {
      type: "tool_call",
      payload: { tool: "web", action: "post", text: "Yes — three of them.", callId: "c1" },
      createdAt: 110,
      seq: 2,
      parentSeq: 1,
    },
    {
      type: "tool_result",
      payload: { tool: "web", action: "post", ok: true, callId: "c1", isError: false, result: "[sent]" },
      createdAt: 120,
      seq: 3,
      parentSeq: 2,
    },
    { type: "assistant", payload: { text: "" }, createdAt: 130, seq: 4 },
    { type: "user", payload: { text: "[keychain wake] credential arrived", hidden: true }, createdAt: 140, seq: 5 },
    {
      type: "tool_call",
      payload: { tool: "execute", command: "use-credential" },
      createdAt: 150,
      seq: 6,
      parentSeq: 5,
    },
    { type: "tool_result", payload: { tool: "execute", code: 0 }, createdAt: 160, seq: 7, parentSeq: 6 },
    { type: "assistant", payload: { text: "Credential loaded; task complete." }, createdAt: 170, seq: 8 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  const last = msgs[msgs.length - 1] as AssistantWork;
  assert.equal(
    (last.content[0] as { text: string }).text,
    "Credential loaded; task complete.",
    "the later turn's reply is not demoted by the earlier turn's post",
  );
});

test("a still-running turn (no closing entry yet) is not promoted", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "go" }, createdAt: 100, seq: 1 },
    { type: "text", payload: { text: "Working on it." }, createdAt: 110, seq: 2, parentSeq: 1 },
    { type: "tool_call", payload: { tool: "execute", command: "ls" }, createdAt: 120, seq: 3, parentSeq: 2 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  const msg = msgs[msgs.length - 1] as AssistantWork;
  assert.equal(
    (msg.content[0] as { text: string }).text,
    "",
    "an in-flight turn keeps streaming live; the rebuild doesn't fake a reply",
  );
  assert.deepEqual(
    msg.work?.activity.map((a) => a.type),
    ["text", "tool_call"],
  );
});

test("a closed empty turn with no narration stays a bare work row", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "[background job update] tick", hidden: true }, createdAt: 100, seq: 1 },
    { type: "tool_call", payload: { tool: "execute", command: "tail log" }, createdAt: 110, seq: 2, parentSeq: 1 },
    { type: "tool_result", payload: { tool: "execute", code: 0 }, createdAt: 120, seq: 3, parentSeq: 2 },
    { type: "assistant", payload: { text: "" }, createdAt: 130, seq: 4 },
  ];
  const msg = entriesToMessages(entries, MODEL)[0] as AssistantWork;
  assert.equal((msg.content[0] as { text: string }).text, "");
  assert.deepEqual(
    msg.work?.activity.map((a) => a.type),
    ["tool_call", "tool_result"],
  );
});

test("a mid-turn hidden entry (resume/wake note) does not split the turn; promotion still fires", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "[background job update] fetch done", hidden: true }, createdAt: 100, seq: 1 },
    { type: "text", payload: { text: "Applying the fixes." }, createdAt: 110, seq: 2, parentSeq: 1 },
    { type: "tool_call", payload: { tool: "execute", command: "node apply.js" }, createdAt: 120, seq: 3, parentSeq: 2 },
    { type: "tool_result", payload: { tool: "execute", code: 0 }, createdAt: 130, seq: 4, parentSeq: 3 },
    {
      type: "user",
      payload: { text: "(system note: the platform restarted mid-turn…)", hidden: true },
      createdAt: 140,
      seq: 5,
    },
    { type: "assistant", payload: { text: "" }, createdAt: 150, seq: 6 },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  assert.equal(msgs.length, 1, "one turn, not a bare row plus a separate empty block");
  const msg = msgs[0] as AssistantWork;
  assert.equal((msg.content[0] as { text: string }).text, "Applying the fixes.");
  assert.deepEqual(
    msg.work?.activity.map((a) => a.type),
    ["tool_call", "tool_result"],
  );
});

test("a turn resumed past a hidden note renders as one block with the real reply", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "[background job update] fetch done", hidden: true }, createdAt: 100, seq: 1 },
    {
      type: "tool_call",
      payload: { tool: "execute", command: "node rebuild.js" },
      createdAt: 110,
      seq: 2,
      parentSeq: 1,
    },
    { type: "tool_result", payload: { tool: "execute", code: 0 }, createdAt: 120, seq: 3, parentSeq: 2 },
    {
      type: "user",
      payload: { text: "(system note: the platform restarted mid-turn…)", hidden: true },
      createdAt: 130,
      seq: 4,
    },
    {
      type: "assistant",
      payload: { text: "Recon-app rebuilt and republished — all eight are live." },
      createdAt: 140,
      seq: 5,
    },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  assert.equal(msgs.length, 1);
  const msg = msgs[0] as AssistantWork;
  assert.equal((msg.content[0] as { text: string }).text, "Recon-app rebuilt and republished — all eight are live.");
  assert.deepEqual(
    msg.work?.activity.map((a) => a.type),
    ["tool_call", "tool_result"],
    "the work block is not split at the hidden note",
  );
});

test("a file-only post (empty text) still renders its delivered files", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "just send the file" }, createdAt: 100, seq: 0 },
    {
      type: "tool_call",
      payload: { tool: "web", action: "post", text: "", files: ["out/report.pdf"], callId: "c2" },
      createdAt: 110,
      seq: 1,
      parentSeq: 0,
    },
    {
      type: "tool_result",
      payload: {
        tool: "web",
        action: "post",
        ok: true,
        callId: "c2",
        isError: false,
        result: "[sent]",
        files: [{ name: "report.pdf", mimetype: "application/pdf", sizeBytes: 512, artifactId: "art-7" }],
      },
      createdAt: 120,
      seq: 2,
      parentSeq: 1,
    },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  const reply = msgs[1] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(reply.role, "assistant");
  assert.equal(reply.content[0]?.text, "");
  assert.deepEqual(
    reply.deliveredFiles?.map((f) => ({ name: f.name, artifactId: f.artifactId })),
    [{ name: "report.pdf", artifactId: "art-7" }],
    "the file-only post's attachment still surfaces on the message",
  );
});

test("a surface post's sent files render as delivered files on the reply bubble", () => {
  const entries: SessionEntry[] = [
    { type: "user", payload: { text: "send the drafts" }, createdAt: 100, seq: 0 },
    {
      type: "tool_call",
      payload: {
        tool: "web",
        action: "post",
        text: "Here they are — profiles A/B/C.",
        files: ["qm-brand/profile_A.png", "qm-brand/profile_B.png"],
        callId: "c1",
      },
      createdAt: 110,
      seq: 1,
      parentSeq: 0,
    },
    {
      type: "tool_result",
      payload: {
        tool: "web",
        action: "post",
        ok: true,
        callId: "c1",
        isError: false,
        result: "[sent]",
        files: [
          { name: "profile_A.png", mimetype: "image/png", sizeBytes: 28720, artifactId: "art-1" },
          { name: "profile_B.png", mimetype: "image/png", sizeBytes: 21922, artifactId: "art-2" },
        ],
      },
      createdAt: 120,
      seq: 2,
      parentSeq: 1,
    },
  ];
  const msgs = entriesToMessages(entries, MODEL);
  const reply = msgs[1] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(reply.role, "assistant");
  assert.equal(reply.content[0]?.text, "Here they are — profiles A/B/C.");
  assert.deepEqual(
    reply.deliveredFiles?.map((f) => ({ name: f.name, artifactId: f.artifactId })),
    [
      { name: "profile_A.png", artifactId: "art-1" },
      { name: "profile_B.png", artifactId: "art-2" },
    ],
    "the attachments the post actually sent are surfaced on the message",
  );
});
