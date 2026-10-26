import type { Item } from "../src/items.ts";
import { item } from "./item-fixture.ts";
import { activityItems, activitySeq, type WorkActivity } from "../src/items.ts";

const kinds = (work: { activity: WorkActivity[] } | undefined) =>
  activityItems(work?.activity ?? []).map((a) => a.kind);
import { buildTimeline, messageWorkTimeline } from "../src/timeline.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  attachPendingApprovals,
  appendConsumedSteers,
  forkCutSeq,
  continuableMessages,
  messagesWithStreaming,
  currentEarlierCount,
  itemsToMessages,
  forkOriginDetails,
  inheritedRefreshItems,
  inheritedTranscript,
  loadInheritedTranscript,
  type AssistantWork,
  type PendingApproval,
} from "../src/core-bridge.ts";

test("approval decisions remain visible history events instead of unresolved tool rows", () => {
  const messages = itemsToMessages([
    item("UserMessage", { seq: 1, createdAt: 1, text: "show help" }),
    item("ToolResult", { seq: 2, createdAt: 2, tool: "execute", body: { blocked: "needs_approval" } }),
    item("AgentMessage", { seq: 3, createdAt: 3, text: "" }),
    item("ElicitationResponse", {
      seq: 4,
      createdAt: 4,
      elicitId: "req",
      approved: false,
      body: { command: "rm -r --help" },
    }),
    item("ElicitationResponse", {
      seq: 5,
      createdAt: 5,
      elicitId: "req",
      approved: true,
      body: { command: "rm -r --help", scope: "once" },
    }),
  ]);
  assert.deepEqual(messages.slice(-2), [
    {
      role: "approval-decision",
      command: "rm -r --help",
      approved: false,
      requestId: "req",
      timestamp: 4,
      entrySeq: 4,
    },
    {
      role: "approval-decision",
      command: "rm -r --help",
      approved: true,
      requestId: "req",
      scope: "once",
      timestamp: 5,
      entrySeq: 5,
    },
  ]);
});

test("steering keeps the active turn together through hydration and tool completion", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 1, seq: 1, text: "start" }),
    item("AgentMessage", {
      createdAt: 2,
      seq: 2,
      variant: "narration",
      text: "Working",
      body: { phase: "commentary" },
    }),
    item("ToolCall", { createdAt: 3, seq: 3, tool: "execute", callId: "one", body: { command: "sleep 40" } }),
    item("SteeringMessage", { createdAt: 4, seq: 4, text: "change direction" }),
    item("SteeringMessage", { createdAt: 5, seq: 5, text: "finish briefly" }),
  ];
  const active = itemsToMessages(items);
  assert.deepEqual(
    active.map((message) => message.role),
    ["user", "user", "user", "assistant"],
  );
  const resumed = continuableMessages(active);
  assert.deepEqual(
    resumed.messages.map((message) => message.role),
    ["user", "user", "user"],
  );
  assert.equal(resumed.popped.length, 1);
  assert.deepEqual((resumed.popped[0] as AssistantWork).work?.activity.map(activitySeq), [2, 3, 4, 5]);
  const finished = itemsToMessages([
    ...items,
    item("ToolResult", { createdAt: 6, seq: 6, tool: "execute", callId: "one", body: { code: 0 } }),
    item("AgentMessage", { createdAt: 7, seq: 7, text: "Done" }),
  ]);
  assert.deepEqual(
    finished.map((message) => message.role),
    ["user", "user", "user", "assistant"],
  );
  const work = (finished.at(-1) as AssistantWork).work!;
  assert.deepEqual(work.activity.map(activitySeq), [2, 3, 4, 5, 6]);
  assert.deepEqual(
    buildTimeline(work).map((item) => item.kind),
    ["text", "tool", "steer", "steer"],
  );
  const tools = buildTimeline(work).filter((item) => item.kind === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.row.call?.seq, 3);
  assert.equal(tools[0]!.row.result?.seq, 6);
});

test("steering preserves an in-flight post and does not promote its closing narration", () => {
  const messages = itemsToMessages([
    item("UserMessage", { createdAt: 1, seq: 1, text: "start" }),
    item("ToolCall", { createdAt: 2, seq: 2, tool: "web", callId: "one", body: { action: "post", text: "Delivered" } }),
    item("SteeringMessage", { createdAt: 3, seq: 3, text: "finish briefly" }),
    item("ToolResult", { createdAt: 4, seq: 4, tool: "web", callId: "one", body: { action: "post", ok: true } }),
    item("SteeringMessage", { createdAt: 5, seq: 5, text: "no more posts" }),
    item("AgentMessage", { createdAt: 6, seq: 6, variant: "narration", text: "Finished posting" }),
    item("AgentMessage", { createdAt: 7, seq: 7, text: "" }),
  ]);
  const replies = messages.filter((message) => message.role === "assistant") as AssistantWork[];
  assert.equal(replies.length, 2);
  assert.deepEqual(
    replies.map((message) => message.content),
    [[{ type: "text", text: "Delivered" }], [{ type: "text", text: "" }]],
  );
  assert.deepEqual(replies[1]!.work?.activity.map(activitySeq), [5, 6]);
});

test("fork provenance separates inherited items at the boundary", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 1, seq: 1, text: "old" }),
    item("AgentMessage", { createdAt: 2, seq: 2, text: "copied" }),
    item("UserMessage", { createdAt: 3, seq: 3, text: "new" }),
  ];
  const collapsed = inheritedTranscript(
    { forkedFrom: { sessionId: "source", title: "Original" }, forkBoundarySeq: 2 },
    items,
  );
  assert.deepEqual(
    collapsed.inherited.map((entry) => entry.seq),
    [1, 2],
  );
  assert.deepEqual(
    collapsed.current.map((entry) => entry.seq),
    [3],
  );
  assert.deepEqual(inheritedTranscript({}, items), { inherited: [], current: items });
});

test("inherited transcript requires complete provenance", () => {
  const sequenced = item("UserMessage", { createdAt: 1, seq: 2, text: "old" });
  assert.deepEqual(inheritedTranscript({ forkedFrom: { sessionId: "source" } }, [sequenced]), {
    inherited: [],
    current: [sequenced],
  });
  assert.deepEqual(inheritedTranscript({ forkBoundarySeq: 2 }, [sequenced]), {
    inherited: [],
    current: [sequenced],
  });
});

test("inherited expansion pages backward to the start and preserves transcript order", async () => {
  const session = { id: "fork", forkedFrom: { sessionId: "source" }, forkBoundarySeq: 50 };
  const first = item("UserMessage", { createdAt: 1, seq: 1, text: "first" }) as Item;
  const middle = item("AgentMessage", { createdAt: 2, seq: 25, text: "middle" }) as Item;
  const last = item("UserMessage", { createdAt: 3, seq: 50, text: "last" }) as Item;
  const calls: unknown[] = [];
  const fetcher = async (id: string, window?: { tailTurns?: number; beforeSeq?: number }) => {
    calls.push({ id, window });
    return window?.beforeSeq === 51 ? { items: [middle, last], earlierItems: 1 } : { items: [first], earlierItems: 0 };
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
  const pages: Record<number, { items: Item[]; earlierItems: number }> = {
    3: {
      items: [item("AgentMessage", { createdAt: 3, seq: 2, text: "two" }) as Item],
      earlierItems: 2,
    },
    2: {
      items: [item("UserMessage", { createdAt: 2, seq: 1, text: "one" }) as Item],
      earlierItems: 1,
    },
    1: {
      items: [item("UserMessage", { createdAt: 1, seq: 0, text: "zero" }) as Item],
      earlierItems: 0,
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

test("currentEarlierCount hides inherited items from the earlier-messages count", () => {
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
  const state = { inheritedMessages: [] as Item[], inheritedLoaded: false, inheritedExpanded: false };
  const pending: Array<(items: Item[]) => void> = [];
  const controller = createForkOriginController<Item>({
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
  pending[0]!([item("UserMessage", { createdAt: 1, seq: 0, text: "fork A history" }) as Item]);
  await firstToggle;
  assert.equal(state.inheritedLoaded, false, "stale load is discarded");
  assert.equal(state.inheritedMessages.length, 0, "stale load is discarded");
  pending[1]!([item("UserMessage", { createdAt: 2, seq: 0, text: "fork B history" }) as Item]);
  await secondToggle;
  assert.equal(state.inheritedLoaded, true);
  assert.equal(state.inheritedExpanded, true);
  assert.equal(state.inheritedMessages[0]!.text, "fork B history");
});

test("a failed show load surfaces an error instead of dying silently", async () => {
  const { createForkOriginController } = await import("../src/fork-origin.ts");
  const state = { inheritedMessages: [] as Item[], inheritedLoaded: false, inheritedExpanded: false };
  let error = "";
  let redraws = 0;
  const controller = createForkOriginController<Item>({
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
  const ok = createForkOriginController<Item>({
    state,
    load: async () => [item("UserMessage", { createdAt: 1, seq: 0, text: "old" }) as Item],
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
  const state = { inheritedMessages: [] as Item[], inheritedLoaded: false, inheritedExpanded: false };
  let error = "sticky old failure";
  let resolveLoad: ((items: Item[]) => void) | null = null;
  const controller = createForkOriginController<Item>({
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
  resolveLoad!([item("UserMessage", { createdAt: 1, seq: 0, text: "old" }) as Item]);
  await toggling;
  assert.equal(state.inheritedLoaded, true);
  assert.equal(state.inheritedExpanded, true);
  assert.equal(error, "", "no error after a successful show");
});

test("fork origin remains visible when a deep-link tail contains only post-fork items", () => {
  const session = { forkedFrom: { sessionId: "source", title: "Original" }, forkBoundarySeq: 10 };
  const postForkTail = Array.from({ length: 25 }, (_, index) =>
    item("UserMessage", { text: String(index), createdAt: index, seq: 11 + index }),
  );
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
  const state = { inheritedMessages: [] as Item[], inheritedLoaded: false, inheritedExpanded: false };
  let error = "";
  let navigationFails = false;
  let navigations = 0;
  const calls: number[] = [];
  const fetcher = async (_id: string, window?: { beforeSeq?: number }) => {
    calls.push(window?.beforeSeq ?? 0);
    return window?.beforeSeq === 3
      ? {
          items: [item("AgentMessage", { text: "old two", createdAt: 2, seq: 2 })],
          earlierItems: 1,
        }
      : {
          items: [item("UserMessage", { text: "old one", createdAt: 1, seq: 1 })],
          earlierItems: 0,
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
        node.textContent = entry.text;
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
  const refresh = inheritedRefreshItems(
    session,
    [item("AgentMessage", { createdAt: 3, seq: 3, text: "new reply" })],
    state.inheritedLoaded,
  );
  assert.equal(refresh, null);
  host.querySelector<HTMLButtonElement>(".fork-origin-toggle")!.click();
  assert.match(host.textContent ?? "", /old one/);
  assert.equal(host.textContent?.match(/old one/g)?.length, 1);
  const noOrigin = forkOriginDetails({}, 0);
  render(noOrigin ? forkOriginView({ ...noOrigin, expanded: false, navigate() {}, toggle() {} }) : null, host);
  assert.equal(host.querySelector(".fork-origin-badge"), null);
  dom.window.close();
});

const MODEL = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Parameters<typeof itemsToMessages>[1];

test("tool items are folded into the following assistant reply's work block", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "hi" }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "execute", body: { command: "ls" } }),
    item("ToolResult", { createdAt: 120, seq: 3, tool: "execute", text: "a\nb", body: { code: 0 } }),
    item("AgentMessage", { createdAt: 130, text: "done" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 2, "user + assistant");
  const work = (msgs[1] as AssistantWork).work;
  assert.ok(work, "the assistant reply carries a work block");
  assert.equal(work?.status, "complete");
  assert.equal(work?.startedAt, 110, "work starts at the first tool step");
  assert.equal(work?.finishedAt, 130, "work ends at the assistant reply");
  assert.deepEqual(kinds(work), ["ToolCall", "ToolResult"]);
});

test("a subagent mail entry carries a structured ref so the transcript can render a chip", () => {
  const envelope = [
    '<wake reason="subagent" name="Poet &quot;one&quot;" sessionId="child-1" kind="final_answer" at="2026-09-03T00:00:00.000Z">',
    '  <why>Your subagent session "Poet one" finished a turn and sent back its result.</why>',
    "  <content>the poem</content>",
    "</wake>",
  ].join("\n");
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: envelope, body: { display: "[subagent Poet one: final answer]" } }),
    item("AgentMessage", { createdAt: 110, text: "here it is" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const mail = (msgs[0] as { subagentMail?: { sessionId: string; title: string; kind: string } }).subagentMail;
  assert.deepEqual(mail, { sessionId: "child-1", title: 'Poet "one"', kind: "final_answer" });
  const plain = itemsToMessages([item("UserMessage", { createdAt: 100, text: "hi" })], MODEL);
  assert.equal((plain[0] as { subagentMail?: unknown }).subagentMail, undefined);
});

test("a hidden proactive-opener user entry never renders, but its assistant greeting does", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "open the conversation", hidden: true }),
    item("AgentMessage", { createdAt: 110, text: "Hi — I'm your AI teammate 👋" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 1, "only the greeting, never the opener seed");
  assert.equal((msgs[0] as { role?: string }).role, "assistant");
});

test("a delivered cron reply renders as an assistant reply", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "remind me later" }),
    item("AgentMessage", { createdAt: 110, text: "will do" }),
    item("AgentMessage", { createdAt: 200, seq: 2, text: "Reminder: standup in 10 minutes", body: { via: "cron" } }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 3, "user + reply + delivered reminder");
  const delivered = msgs[2] as AssistantWork & { role?: string; content?: Array<{ text?: string }> };
  assert.equal(delivered.role, "assistant");
  assert.equal(delivered.content?.[0]?.text, "Reminder: standup in 10 minutes");
  assert.equal(delivered.work, undefined, "a delivery is a reply, not tool activity");
});

test("a migrated reply and delivered-file entry render text and file chips", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "make gifs" }),
    item("AgentMessage", { createdAt: 120, seq: 1, text: "rsi.gif" }),
    item("AgentMessage", {
      createdAt: 121,
      seq: 2,
      variant: "files_delivered",
      body: { files: [{ name: "rsi.gif", mimetype: "image/gif", sizeBytes: 42, artifactId: "art-1" }] },
    }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 2);
  assert.deepEqual((msgs[1] as AssistantWork).deliveredFiles, [
    { name: "rsi.gif", mimetype: "image/gif", sizeBytes: 42, artifactId: "art-1" },
  ]);
});

test("a durable turn_failure entry renders like the live inline error (survives reload)", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "how did it go?" }),
    item("Error", { createdAt: 110, errorCode: "turn_failure", text: "API integrators: you can reduce refusals…" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 2, "user + error");
  const err = msgs[1] as { role?: string; stopReason?: string; errorMessage?: string };
  assert.equal(err.role, "assistant");
  assert.equal(err.stopReason, "error");
  assert.equal(err.errorMessage, "API integrators: you can reduce refusals…");
});

test("user items carry the stored speaker identity, name and slack ts onto the rebuilt message", () => {
  const items: Item[] = [
    item("UserMessage", {
      createdAt: 100,
      text: "hi",
      externalId: "100.1",
      body: { name: "Alice Example", speakerId: "person-a" },
    }),
    item("UserMessage", { createdAt: 110, text: "anonymous web message" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const [slack, web] = msgs as Array<{ speaker?: string; speakerId?: string; ts?: string }>;
  assert.equal(slack?.speaker, "Alice Example");
  assert.equal(slack?.speakerId, "person-a");
  assert.equal(slack?.ts, "100.1");
  assert.equal(web?.speaker, undefined);
  assert.equal(web?.speakerId, undefined);
  assert.equal(web?.ts, undefined);
});

test("a message_revision marker renders as a system note and badges the original bubble", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "original", externalId: "100.1", body: { name: "Alice Example" } }),
    item("AgentMessage", { createdAt: 110, text: "reply" }),
    item("Retraction", {
      createdAt: 120,
      body: { action: "edited", ts: "100.1", text: "fixed", name: "Alice Example" },
    }),
    item("Retraction", { createdAt: 130, body: { action: "deleted", ts: "100.1", name: "Alice Example" } }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 4, "user + reply + edit note + delete note");
  const original = msgs[0] as { edited?: boolean; deleted?: boolean };
  assert.equal(original.edited, true);
  assert.equal(original.deleted, true);
  const note = msgs[2] as { role?: string; action?: string; content?: string; speaker?: string; timestamp?: number };
  assert.equal(note.role, "system-note");
  assert.equal(note.action, "edited");
  assert.equal(note.content, "fixed");
  assert.equal(note.speaker, "Alice Example");
  assert.equal(note.timestamp, 120);
  assert.equal((msgs[3] as { action?: string }).action, "deleted");
});

test("a revision marker whose original message is outside the window still renders as a note", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 200, text: "later message", externalId: "200.0" }),
    item("Retraction", { createdAt: 210, body: { action: "deleted", ts: "100.1" } }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 2);
  assert.equal((msgs[0] as { deleted?: boolean }).deleted, undefined, "the wrong bubble is never badged");
  assert.equal((msgs[1] as { role?: string }).role, "system-note");
});

test("other system items (file events, context summaries) still never render", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "hi" }),
    item("ContextCompaction", { createdAt: 106, throughSeq: 1, text: "summary" }),
    item("AgentMessage", { createdAt: 110, text: "hello" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 2, "user + assistant only");
});

test("a turn with no tool items gets no work block (plain markdown, prior behavior)", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 200, text: "again" }),
    item("AgentMessage", { createdAt: 210, text: "plain" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal((msgs[1] as AssistantWork).work, undefined);
});

test("user attachments survive the reload rebuild — image with text keeps a renderable attachment", () => {
  const items: Item[] = [
    item("UserMessage", {
      createdAt: 100,
      seq: 1,
      text: "look at this",
      body: {
        attachments: [
          { name: "shot.png", mimetype: "image/png", sizeBytes: 116526, direction: "in", artifactId: "art-9" },
        ],
      },
    }),
    item("AgentMessage", { createdAt: 110, text: "Looking." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const user = msgs[0] as { role?: string; content?: string; attachments?: Array<Record<string, unknown>> };
  assert.equal(user.role, "user");
  assert.equal(user.content, "look at this", "the text stays the bubble text");
  assert.deepEqual(user.attachments, [
    { id: "art-9", type: "image", fileName: "shot.png", mimeType: "image/png", size: 116526, artifactId: "art-9" },
  ]);
});

test("an attachment-only user entry rebuilds as a real user message with attachments, not a \u{1F4CE} text line", () => {
  const items: Item[] = [
    item("UserMessage", {
      createdAt: 100,
      seq: 1,
      text: "",
      body: {
        attachments: [{ name: "cat.png", mimetype: "image/png", sizeBytes: 5, direction: "in", artifactId: "art-1" }],
      },
    }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 1);
  const user = msgs[0] as { content?: string; attachments?: Array<{ fileName?: string }> };
  assert.equal(user.content, "", "no synthetic emoji line");
  assert.equal(user.attachments?.[0]?.fileName, "cat.png");
});

test("a legacy user entry without artifactId keeps a metadata-only attachment (chip fallback)", () => {
  const items: Item[] = [
    item("UserMessage", {
      createdAt: 100,
      seq: 3,
      text: "old one",
      body: { attachments: [{ name: "doc.pdf", mimetype: "application/pdf", sizeBytes: 9, direction: "in" }] },
    }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const att = (msgs[0] as { attachments?: Array<Record<string, unknown>> }).attachments?.[0];
  assert.ok(att, "attachment survives");
  assert.equal(att!.type, "document");
  assert.equal(att!.artifactId, undefined, "no fabricated artifact link");
});

test("an attach tool result attaches openable files to the turn's assistant message", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "make a report" }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "attach", callId: "c1", body: { files: ["report.md"] } }),
    item("ToolResult", {
      createdAt: 111,
      seq: 3,
      tool: "attach",
      callId: "c1",
      body: { ok: true, files: [{ name: "report.md", mimetype: "text/markdown", sizeBytes: 12, artifactId: "art-9" }] },
    }),
    item("AgentMessage", { createdAt: 120, text: "Here it is." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.deepEqual((msgs[1] as AssistantWork).deliveredFiles, [
    { name: "report.md", mimetype: "text/markdown", sizeBytes: 12, artifactId: "art-9" },
  ]);
});

test("re-attaching a path renders one chip, not two", () => {
  const attachResult = (callId: string, artifactId: string, seq: number): Item =>
    item("ToolResult", {
      createdAt: 110 + seq,
      seq,
      tool: "attach",
      callId: callId,
      body: { ok: true, files: [{ name: "report.md", mimetype: "text/markdown", sizeBytes: 12, artifactId }] },
    });
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "make a report" }),
    attachResult("c1", "art-draft", 3),
    attachResult("c2", "art-fixed", 5),
    item("AgentMessage", { createdAt: 120, text: "Here it is." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.deepEqual((msgs[1] as AssistantWork).deliveredFiles, [
    { name: "report.md", mimetype: "text/markdown", sizeBytes: 12, artifactId: "art-fixed" },
  ]);
});

test("a failed attach tool result attaches no files", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "make a report" }),
    item("ToolResult", { createdAt: 111, seq: 3, tool: "attach", callId: "c1", body: { ok: false } }),
    item("AgentMessage", { createdAt: 120, text: "I could not find it." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal((msgs[1] as AssistantWork).deliveredFiles, undefined);
});

test("tool items from a prior turn don't leak into the next turn's assistant reply", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "one" }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "read", body: { path: "/x" } }),
    item("UserMessage", { createdAt: 200, text: "two" }),
    item("AgentMessage", { createdAt: 210, text: "answer" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const last = msgs[msgs.length - 1] as AssistantWork;
  assert.equal(last.work, undefined, "the second turn's reply carries none of the first turn's activity");
  assert.ok(msgs.some((m) => kinds((m as AssistantWork).work).includes("ToolCall")));
});

test("a turn paused mid-stream (no closing assistant entry) flushes its activity into a work block", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "do it" }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "execute", body: { command: "rm -rf x" } }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 2, "user + a synthetic assistant holding the paused activity");
  const work = (msgs[1] as AssistantWork).work;
  assert.ok(work, "trailing tool activity is not dropped");
  assert.deepEqual(kinds(work), ["ToolCall"]);
});

test("attachPendingApprovals hangs approvals on the trailing assistant turn after reload", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "do it" }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "execute", body: { command: "deploy" } }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const approvals: PendingApproval[] = [{ requestId: "r1", command: "deploy", reason: "needs ok" }];
  attachPendingApprovals(msgs, approvals, MODEL);
  assert.deepEqual((msgs[msgs.length - 1] as AssistantWork).work?.pendingApprovals, approvals);
});

test("attachPendingApprovals anchors a stale approval to its own turn, not the latest one", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "do it" }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "execute", body: { command: "deploy" } }),
    item("UserMessage", { createdAt: 200, text: "actually, nvm — what time is it?" }),
    item("AgentMessage", { createdAt: 210, text: "It's noon." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const before = msgs.length;
  const approvals: PendingApproval[] = [{ requestId: "r1", command: "deploy", reason: "needs ok" }];
  attachPendingApprovals(msgs, approvals, MODEL);
  assert.equal(msgs.length, before, "no synthetic turn is appended");
  const deployTurn = msgs.find((m) => kinds((m as AssistantWork).work).includes("ToolCall")) as AssistantWork;
  assert.deepEqual(deployTurn.work?.pendingApprovals, approvals, "buttons hang on the deploy turn");
  assert.equal((msgs[msgs.length - 1] as AssistantWork).work?.pendingApprovals, undefined, "not on the latest turn");
});

test("attachPendingApprovals attaches to a completed turn that carries the paused command (ok + pendingApprovals)", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, text: "deploy it in the background" }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "execute", body: { command: "deploy" } }),
    item("AgentMessage", { createdAt: 120, text: "Kicking that off." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
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
  const msgs = itemsToMessages([item("UserMessage", { createdAt: 100, text: "approve please" })], MODEL);
  const approvals: PendingApproval[] = [{ requestId: "r1", command: "deploy" }];
  attachPendingApprovals(msgs, approvals, MODEL);
  const last = msgs[msgs.length - 1] as AssistantWork;
  assert.equal(last.role, "assistant");
  assert.deepEqual(last.work?.pendingApprovals, approvals);
});

test("thinking items are interleaved into the work block by seq (reload path)", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 1, text: "do it" }),
    item("Reasoning", { createdAt: 110, seq: 2, text: "let me look" }),
    item("ToolCall", { createdAt: 120, seq: 3, tool: "execute", body: { command: "ls" } }),
    item("ToolResult", { createdAt: 130, seq: 4, tool: "execute", body: { code: 0 } }),
    item("Reasoning", { createdAt: 135, seq: 5, text: "", body: { redacted: true } }),
    item("AgentMessage", { createdAt: 140, seq: 6, text: "done" }),
  ];
  const work = (itemsToMessages(items, MODEL)[1] as AssistantWork).work;
  assert.deepEqual(
    kinds(work),
    ["Reasoning", "ToolCall", "ToolResult"],
    "renderable thinking is kept in seq order; the redacted (empty) thinking is dropped",
  );
});

test("interstitial text items fold into the work timeline; the final reply stays separate", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 1, text: "go" }),
    item("AgentMessage", { createdAt: 110, seq: 2, variant: "narration", text: "Looking now." }),
    item("ToolCall", { createdAt: 120, seq: 3, tool: "execute", body: { command: "ls" } }),
    item("ToolResult", { createdAt: 130, seq: 4, tool: "execute", body: { code: 0 } }),
    item("AgentMessage", { createdAt: 140, seq: 5, text: "All set." }),
  ];
  const msg = itemsToMessages(items, MODEL)[1] as AssistantWork;
  assert.deepEqual(
    kinds(msg.work),
    ["AgentMessage", "ToolCall", "ToolResult"],
    "narration is woven into the work block in seq order",
  );
  assert.equal(
    (msg.content[0] as { text: string }).text,
    "All set.",
    "the final reply is the assistant entry, not a text segment",
  );
});

test("a turn ending on a tool-call step doesn't duplicate its narration (reply == last text)", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 1, text: "delete it" }),
    item("AgentMessage", { createdAt: 110, seq: 2, variant: "narration", text: "Deleting now." }),
    item("ToolCall", { createdAt: 120, seq: 3, tool: "execute", body: { command: "rm -rf x" } }),
    item("ToolResult", { createdAt: 130, seq: 4, tool: "execute", body: { blocked: "needs_approval" } }),
    item("AgentMessage", { createdAt: 140, seq: 5, text: "Deleting now." }),
  ];
  const msg = itemsToMessages(items, MODEL)[1] as AssistantWork;
  assert.deepEqual(
    kinds(msg.work),
    ["ToolCall", "ToolResult"],
    "the duplicated narration segment is dropped from the work block",
  );
  assert.equal((msg.content[0] as { text: string }).text, "Deleting now.", "it shows once, as the reply");
});

test("a wake-wrapped user entry renders its display text, never the raw envelope", () => {
  const items: Item[] = [
    item("UserMessage", {
      createdAt: 100,
      seq: 0,
      text: '<wake reason="addressed" surface="web"><addressed-messages>…</addressed-messages></wake>',
      body: { display: "Do you have any policies around sensitive data?", name: "carol" },
    }),
    item("AgentMessage", { createdAt: 130, seq: 1, text: "done" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal((msgs[0] as { content?: string }).content, "Do you have any policies around sensitive data?");
  assert.ok(!JSON.stringify(msgs).includes("<wake"), "the envelope never reaches the transcript");
});

test("a surface post renders as the reply bubble; the closing self-log demotes to work narration", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 0, text: "<wake…>", body: { display: "any policies?" } }),
    item("Reasoning", { createdAt: 105, seq: 1, text: "I should summarize the policies." }),
    item("ToolCall", {
      createdAt: 110,
      seq: 2,
      tool: "web",
      callId: "c1",
      body: { action: "post", text: "Yes — conversation boundaries, credentials, least access." },
    }),
    item("ToolResult", {
      createdAt: 120,
      seq: 3,
      tool: "web",
      callId: "c1",
      text: "[sent]",
      isError: false,
      body: { action: "post", ok: true },
    }),
    item("AgentMessage", { createdAt: 130, seq: 4, text: "Replied in thread with a policy summary." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
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
  assert.deepEqual(messageWorkTimeline(trailer.work!, ""), [], "the demoted-only trailer has no visible work fold");
  assert.ok(
    JSON.stringify(trailer.work?.activity ?? []).includes("Replied in thread"),
    "the self-log survives as work narration",
  );
});

test("a legacy bytes-only post entry keeps the old rendering (work row + closing text as reply)", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 0, text: "hi" }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "web", callId: "c1", body: { action: "post", bytes: 873 } }),
    item("ToolResult", {
      createdAt: 120,
      seq: 3,
      tool: "web",
      callId: "c1",
      text: "[sent]",
      isError: false,
      body: { action: "post", ok: true },
    }),
    item("AgentMessage", { createdAt: 130, seq: 4, text: "Replied in thread." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 2);
  const reply = msgs[1] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(reply.content[0]?.text, "Replied in thread.");
  assert.deepEqual(kinds(reply.work), ["ToolCall", "ToolResult"]);
});

test("a failed text-less post (missing_text) stays visible as a failed work row", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 0, text: "hi" }),
    item("ToolResult", {
      createdAt: 140,
      seq: 5,
      tool: "web",
      callId: "c2",
      text: '[error] the "post" action requires `text`.',
      isError: true,
      body: { action: "post", error: "missing_text" },
    }),
    item("ToolCall", {
      createdAt: 150,
      seq: 6,
      tool: "web",
      callId: "c3",
      body: { action: "post", text: "second try" },
    }),
    item("ToolResult", {
      createdAt: 160,
      seq: 7,
      tool: "web",
      callId: "c3",
      text: "[sent]",
      isError: false,
      body: { action: "post", ok: true },
    }),
    item("AgentMessage", { createdAt: 170, seq: 8, text: "Recovered and replied." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const reply = msgs[1] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(reply.content[0]?.text, "second try");
  assert.ok(
    JSON.stringify(reply.work?.activity ?? []).includes("missing_text"),
    "the failed attempt still shows in the timeline",
  );
});

test("a FAILED post never renders as a delivered reply — its rows stay in the work timeline and the closing text stays the reply", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 0, text: "hi" }),
    item("ToolCall", {
      createdAt: 110,
      seq: 1,
      tool: "web",
      callId: "c1",
      body: { action: "post", text: "undelivered answer" },
    }),
    item("ToolResult", {
      createdAt: 120,
      seq: 2,
      tool: "web",
      callId: "c1",
      text: "[not sent] delivery failed",
      isError: true,
      body: { action: "post", ok: false },
    }),
    item("AgentMessage", { createdAt: 130, seq: 3, text: "I couldn't deliver that reply — the send failed." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
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
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 0, text: "hi" }),
    item("ToolCall", {
      createdAt: 110,
      seq: 1,
      tool: "web",
      callId: "c1",
      body: { action: "post", text: "maybe sent" },
    }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 2);
  const trailer = msgs[1] as AssistantWork & { content: Array<{ text?: string }> };
  assert.equal(trailer.content[0]?.text ?? "", "", "no bubble claims the text was delivered");
  assert.ok(JSON.stringify(trailer.work?.activity ?? []).includes("maybe sent"), "the call is still visible as work");
});

test("a posted turn that closes empty is NOT promoted — the post bubble is already the reply", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 0, text: "<wake…>", body: { display: "any policies?" } }),
    item("ToolCall", {
      createdAt: 110,
      seq: 1,
      tool: "web",
      callId: "c1",
      body: { action: "post", text: "Yes — three of them." },
    }),
    item("ToolResult", {
      createdAt: 120,
      seq: 2,
      tool: "web",
      callId: "c1",
      text: "[sent]",
      isError: false,
      body: { action: "post", ok: true },
    }),
    item("AgentMessage", { createdAt: 130, seq: 3, variant: "narration", text: "Logged the summary for follow-up." }),
    item("ToolCall", { createdAt: 140, seq: 4, tool: "execute", body: { command: "echo done" } }),
    item("ToolResult", { createdAt: 150, seq: 5, tool: "execute", body: { code: 0 } }),
    item("AgentMessage", { createdAt: 160, seq: 6, text: "" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
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
  const items: Item[] = [
    item("UserMessage", {
      createdAt: 100,
      seq: 1,
      text: '<wake reason="monitor" surface="monitor" at="1970-01-01T00:00:00.000Z"><why>fetch done</why></wake>',
      hidden: true,
    }),
    item("AgentMessage", {
      createdAt: 110,
      seq: 2,
      variant: "narration",
      text: "All benign — building the replay harness.",
    }),
    item("ToolCall", { createdAt: 120, seq: 3, tool: "execute", body: { command: "node replay.js" } }),
    item("ToolResult", { createdAt: 130, seq: 4, tool: "execute", body: { code: 0 } }),
    item("AgentMessage", {
      createdAt: 140,
      seq: 5,
      variant: "narration",
      text: "Server.js is nearly true — 8 bad lines. Applying the fixes.",
    }),
    item("ToolCall", { createdAt: 150, seq: 6, tool: "execute", body: { command: "node apply.js" } }),
    item("ToolResult", { createdAt: 160, seq: 7, tool: "execute", body: { code: 0 } }),
    item("AgentMessage", { createdAt: 170, seq: 8, text: "" }),
  ];
  const msg = itemsToMessages(items, MODEL)[0] as AssistantWork;
  assert.equal(
    (msg.content[0] as { text: string }).text,
    "Server.js is nearly true — 8 bad lines. Applying the fixes.",
    "the last narration becomes the visible reply instead of a bare tool-call count",
  );
  assert.deepEqual(
    kinds(msg.work),
    ["AgentMessage", "ToolCall", "ToolResult", "ToolCall", "ToolResult"],
    "the promoted segment moves out of the work block; earlier narration stays",
  );
});

const wakeEntry = (seq: number, createdAt: number): Item =>
  item("UserMessage", {
    createdAt,
    seq,
    text: '<wake reason="monitor" surface="monitor" at="1970-01-01T00:00:00.000Z"><why>still running</why></wake>',
    hidden: true,
  });

const silentFinish = (seq: number, createdAt: number): Item[] => [
  item("ToolCall", { createdAt, seq, tool: "finish_silently", body: { reason: "nothing new" } }),
  item("ToolResult", { createdAt: createdAt + 1, seq: seq + 1, tool: "finish_silently", body: { silent: true } }),
];

test("a wake that only finishes silently leaves nothing in the transcript", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 10, seq: 1, text: "watch the deploy" }),
    item("AgentMessage", { createdAt: 20, seq: 2, text: "Watching." }),
    wakeEntry(3, 100),
    item("AgentMessage", { createdAt: 110, seq: 4, variant: "narration", text: "Heartbeat check." }),
    ...silentFinish(5, 120),
    item("AgentMessage", { createdAt: 140, seq: 7, text: "" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.deepEqual(
    msgs.map((m) => (m as { role: string }).role),
    ["user", "assistant"],
  );
  assert.equal(((msgs[1] as AssistantWork).content[0] as { text: string }).text, "Watching.");
});

test("a silent wake keeps its real tool work but drops the finish_silently call", () => {
  const items: Item[] = [
    wakeEntry(1, 100),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "background", body: { action: "poll" } }),
    item("ToolResult", { createdAt: 115, seq: 3, tool: "background", body: { action: "poll" } }),
    ...silentFinish(4, 120),
    item("AgentMessage", { createdAt: 140, seq: 6, text: "" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 1);
  const msg = msgs[0] as AssistantWork;
  assert.equal((msg.content[0] as { text: string }).text, "", "intentional silence is not turned into a message");
  assert.deepEqual(
    activityItems(msg.work?.activity ?? []).map((a) => a.tool),
    ["background", "background"],
  );
});

test("a wake that replies is unchanged", () => {
  const items: Item[] = [
    wakeEntry(1, 100),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "background", body: { action: "poll" } }),
    item("ToolResult", { createdAt: 115, seq: 3, tool: "background", body: { action: "poll" } }),
    item("AgentMessage", { createdAt: 140, seq: 4, text: "Deploy finished." }),
  ];
  const msg = itemsToMessages(items, MODEL)[0] as AssistantWork;
  assert.equal((msg.content[0] as { text: string }).text, "Deploy finished.");
  assert.equal(msg.work?.activity.length, 2);
});

test("a visible turn that finishes silently still shows the finish_silently call", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 1, text: "no reply needed" }),
    item("AgentMessage", { createdAt: 110, seq: 2, variant: "narration", text: "Nothing to add." }),
    ...silentFinish(3, 120),
    item("AgentMessage", { createdAt: 140, seq: 5, text: "" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const msg = msgs[msgs.length - 1] as AssistantWork;
  assert.equal((msg.content[0] as { text: string }).text, "", "intentional silence is not turned into a message");
  assert.deepEqual(kinds(msg.work), ["AgentMessage", "ToolCall", "ToolResult"]);
});

test("a no-op finish_silently (non-poll, no silent:true) does NOT suppress promotion", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 1, text: "do it" }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "finish_silently" }),
    item("ToolResult", { createdAt: 120, seq: 3, tool: "finish_silently", body: { noop: "not_a_poll_fire" } }),
    item("AgentMessage", { createdAt: 130, seq: 4, variant: "narration", text: "Actually, here's the result." }),
    item("ToolCall", { createdAt: 140, seq: 5, tool: "execute", body: { command: "ls" } }),
    item("ToolResult", { createdAt: 150, seq: 6, tool: "execute", body: { code: 0 } }),
    item("AgentMessage", { createdAt: 160, seq: 7, text: "" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const msg = msgs[msgs.length - 1] as AssistantWork;
  assert.equal(
    (msg.content[0] as { text: string }).text,
    "Actually, here's the result.",
    "a no-op silence call is not real silence",
  );
});

test("an explicit stay_silent decline stays collapsed — narration is not promoted", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 1, text: "<wake…>", body: { display: "fyi thread" } }),
    item("AgentMessage", { createdAt: 110, seq: 2, variant: "narration", text: "Not my place to weigh in here." }),
    item("ToolCall", { createdAt: 120, seq: 3, tool: "stay_silent", body: { reason: "not addressed to me" } }),
    item("ToolResult", { createdAt: 130, seq: 4, tool: "stay_silent", body: { ok: true } }),
    item("AgentMessage", { createdAt: 140, seq: 5, text: "" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const msg = msgs[msgs.length - 1] as AssistantWork;
  assert.equal(
    (msg.content[0] as { text: string }).text,
    "",
    "a deliberate decline is not turned into a visible message",
  );
});

test("posted state does not leak across a hidden turn boundary — the next turn's reply stays visible", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 1, text: "<wake…>", body: { display: "any policies?" } }),
    item("ToolCall", {
      createdAt: 110,
      seq: 2,
      tool: "web",
      callId: "c1",
      body: { action: "post", text: "Yes — three of them." },
    }),
    item("ToolResult", {
      createdAt: 120,
      seq: 3,
      tool: "web",
      callId: "c1",
      text: "[sent]",
      isError: false,
      body: { action: "post", ok: true },
    }),
    item("AgentMessage", { createdAt: 130, seq: 4, text: "" }),
    item("UserMessage", { createdAt: 140, seq: 5, text: "[keychain wake] credential arrived", hidden: true }),
    item("ToolCall", { createdAt: 150, seq: 6, tool: "execute", body: { command: "use-credential" } }),
    item("ToolResult", { createdAt: 160, seq: 7, tool: "execute", body: { code: 0 } }),
    item("AgentMessage", { createdAt: 170, seq: 8, text: "Credential loaded; task complete." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const last = msgs[msgs.length - 1] as AssistantWork;
  assert.equal(
    (last.content[0] as { text: string }).text,
    "Credential loaded; task complete.",
    "the later turn's reply is not demoted by the earlier turn's post",
  );
});

test("a still-running turn (no closing entry yet) is not promoted", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 1, text: "go" }),
    item("AgentMessage", { createdAt: 110, seq: 2, variant: "narration", text: "Working on it." }),
    item("ToolCall", { createdAt: 120, seq: 3, tool: "execute", body: { command: "ls" } }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  const msg = msgs[msgs.length - 1] as AssistantWork;
  assert.equal(
    (msg.content[0] as { text: string }).text,
    "",
    "an in-flight turn keeps streaming live; the rebuild doesn't fake a reply",
  );
  assert.deepEqual(kinds(msg.work), ["AgentMessage", "ToolCall"]);
});

test("a closed empty turn with no narration stays a bare work row", () => {
  const items: Item[] = [
    item("UserMessage", {
      createdAt: 100,
      seq: 1,
      text: '<wake reason="monitor" surface="monitor" at="1970-01-01T00:00:00.000Z"><why>tick</why></wake>',
      hidden: true,
    }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "execute", body: { command: "tail log" } }),
    item("ToolResult", { createdAt: 120, seq: 3, tool: "execute", body: { code: 0 } }),
    item("AgentMessage", { createdAt: 130, seq: 4, text: "" }),
  ];
  const msg = itemsToMessages(items, MODEL)[0] as AssistantWork;
  assert.equal((msg.content[0] as { text: string }).text, "");
  assert.deepEqual(kinds(msg.work), ["ToolCall", "ToolResult"]);
});

test("a mid-turn hidden entry (resume/wake note) does not split the turn; promotion still fires", () => {
  const items: Item[] = [
    item("UserMessage", {
      createdAt: 100,
      seq: 1,
      text: '<wake reason="monitor" surface="monitor" at="1970-01-01T00:00:00.000Z"><why>fetch done</why></wake>',
      hidden: true,
    }),
    item("AgentMessage", { createdAt: 110, seq: 2, variant: "narration", text: "Applying the fixes." }),
    item("ToolCall", { createdAt: 120, seq: 3, tool: "execute", body: { command: "node apply.js" } }),
    item("ToolResult", { createdAt: 130, seq: 4, tool: "execute", body: { code: 0 } }),
    item("UserMessage", {
      createdAt: 140,
      seq: 5,
      text: "(system note: the platform restarted mid-turn…)",
      hidden: true,
    }),
    item("AgentMessage", { createdAt: 150, seq: 6, text: "" }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 1, "one turn, not a bare row plus a separate empty block");
  const msg = msgs[0] as AssistantWork;
  assert.equal((msg.content[0] as { text: string }).text, "Applying the fixes.");
  assert.deepEqual(kinds(msg.work), ["ToolCall", "ToolResult"]);
});

test("a turn resumed past a hidden note renders as one block with the real reply", () => {
  const items: Item[] = [
    item("UserMessage", {
      createdAt: 100,
      seq: 1,
      text: '<wake reason="monitor" surface="monitor" at="1970-01-01T00:00:00.000Z"><why>fetch done</why></wake>',
      hidden: true,
    }),
    item("ToolCall", { createdAt: 110, seq: 2, tool: "execute", body: { command: "node rebuild.js" } }),
    item("ToolResult", { createdAt: 120, seq: 3, tool: "execute", body: { code: 0 } }),
    item("UserMessage", {
      createdAt: 130,
      seq: 4,
      text: "(system note: the platform restarted mid-turn…)",
      hidden: true,
    }),
    item("AgentMessage", { createdAt: 140, seq: 5, text: "Recon-app rebuilt and republished — all eight are live." }),
  ];
  const msgs = itemsToMessages(items, MODEL);
  assert.equal(msgs.length, 1);
  const msg = msgs[0] as AssistantWork;
  assert.equal((msg.content[0] as { text: string }).text, "Recon-app rebuilt and republished — all eight are live.");
  assert.deepEqual(kinds(msg.work), ["ToolCall", "ToolResult"], "the work block is not split at the hidden note");
});

test("a file-only post (empty text) still renders its delivered files", () => {
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 0, text: "just send the file" }),
    item("ToolCall", {
      createdAt: 110,
      seq: 1,
      tool: "web",
      callId: "c2",
      body: { action: "post", text: "", files: ["out/report.pdf"] },
    }),
    item("ToolResult", {
      createdAt: 120,
      seq: 2,
      tool: "web",
      callId: "c2",
      text: "[sent]",
      isError: false,
      body: {
        action: "post",
        ok: true,
        files: [{ name: "report.pdf", mimetype: "application/pdf", sizeBytes: 512, artifactId: "art-7" }],
      },
    }),
  ];
  const msgs = itemsToMessages(items, MODEL);
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
  const items: Item[] = [
    item("UserMessage", { createdAt: 100, seq: 0, text: "send the drafts" }),
    item("ToolCall", {
      createdAt: 110,
      seq: 1,
      tool: "web",
      callId: "c1",
      body: {
        action: "post",
        text: "Here they are — profiles A/B/C.",
        files: ["qm-brand/profile_A.png", "qm-brand/profile_B.png"],
      },
    }),
    item("ToolResult", {
      createdAt: 120,
      seq: 2,
      tool: "web",
      callId: "c1",
      text: "[sent]",
      isError: false,
      body: {
        action: "post",
        ok: true,
        files: [
          { name: "profile_A.png", mimetype: "image/png", sizeBytes: 28720, artifactId: "art-1" },
          { name: "profile_B.png", mimetype: "image/png", sizeBytes: 21922, artifactId: "art-2" },
        ],
      },
    }),
  ];
  const msgs = itemsToMessages(items, MODEL);
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

for (const text of ["Partial answer", "", "(stopped)"]) {
  test(`stopped history retains its state without promoting commentary: ${text || "empty"}`, () => {
    const items: Item[] = [
      item("UserMessage", { seq: 1, createdAt: 1, text: "check" }),
      item("AgentMessage", {
        seq: 2,
        createdAt: 2,
        variant: "narration",
        text: "Checking.",
        body: { phase: "commentary" },
      }),
      item("AgentMessage", { seq: 3, createdAt: 3, text: text, body: { stopped: true } }),
    ];
    const messages = itemsToMessages(items);
    const answer = messages.find((message) => message.role === "assistant") as AssistantWork;
    assert.equal(answer.stopReason, "aborted");
    assert.deepEqual(answer.content, [{ type: "text", text }]);
    assert.equal(answer.work?.activity.length, 1);
    assert.equal(messageWorkTimeline(answer.work!, text)[0]?.kind, "text");
  });
}

test("live approval decisions are outside tool folds and reconcile by request identity", () => {
  const entry = item("ElicitationResponse", {
    seq: 8,
    createdAt: 100,
    elicitId: "approval-1",
    approved: true,
    body: { command: "help", scope: "once" },
  });
  const streaming = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    work: { status: "working", activity: [{ item: entry }] },
  } as unknown as AgentMessage;
  const live = messagesWithStreaming([], streaming);
  assert.equal(live.length, 2);
  assert.equal((live[0] as { role: string }).role, "approval-decision");
  assert.equal(live[1], streaming);
  assert.deepEqual(messagesWithStreaming([streaming]), live);
  assert.deepEqual(buildTimeline((streaming as AssistantWork).work!), []);
  const history = itemsToMessages([entry]);
  assert.deepEqual(messagesWithStreaming(history, streaming), [...history, streaming]);
  const repeated = {
    ...streaming,
    work: { status: "working", activity: [{ item: { ...entry, seq: 9, createdAt: 200 } }] },
  } as unknown as AgentMessage;
  assert.equal(messagesWithStreaming(history, repeated).length, 3);
  const denied = { ...entry, elicitId: "approval-2", approved: false };
  const denialStream = {
    ...streaming,
    work: { status: "complete", activity: [{ item: denied }] },
  } as unknown as AgentMessage;
  assert.equal(messagesWithStreaming(history, denialStream).length, 3);
});

test("a recorded decision clears stale approval labels without consuming a later request", () => {
  const pending = { requestId: "same-command", command: "help" };
  const blocked = (createdAt: number) =>
    ({
      role: "assistant",
      content: [{ type: "text", text: "" }],
      timestamp: createdAt,
      work: {
        status: "complete",
        pendingApprovals: [pending],
        activity: [{ item: item("ToolResult", { seq: 1, createdAt, body: { blocked: "needs_approval" } }) }],
      },
    }) as unknown as AgentMessage;
  const decision = item("ElicitationResponse", {
    seq: 2,
    createdAt: 200,
    elicitId: pending.requestId,
    approved: false,
    body: { command: pending.command },
  });
  const old = blocked(100);
  const fresh = blocked(300);
  const streaming = {
    role: "assistant",
    content: [],
    work: { status: "working", activity: [{ item: decision }] },
  } as unknown as AgentMessage;
  const visible = messagesWithStreaming([old, fresh], streaming);
  assert.deepEqual((visible[0] as AssistantWork).work?.pendingApprovals, []);
  assert.equal(visible[1], fresh);
  assert.deepEqual((old as AssistantWork).work?.pendingApprovals, [pending]);
  const history = messagesWithStreaming([old, ...itemsToMessages([decision]), fresh]);
  assert.deepEqual((history[0] as AssistantWork).work?.pendingApprovals, []);
  assert.equal(history.at(-1), fresh);
});

test("finish_silently retains explicit posts and audit without a phantom closing reply", () => {
  const items: Item[] = [
    item("UserMessage", { seq: 1, createdAt: 100, text: "post the answer" }),
    item("ToolCall", {
      seq: 2,
      createdAt: 110,
      tool: "slack",
      callId: "post1",
      body: { action: "post", text: "The answer." },
    }),
    item("ToolResult", { seq: 3, createdAt: 120, tool: "slack", callId: "post1", body: { action: "post", ok: true } }),
    item("AgentMessage", { seq: 4, createdAt: 130, variant: "narration", text: "Nothing to add." }),
    item("ToolCall", { seq: 5, createdAt: 140, tool: "finish_silently", body: { reason: "already posted" } }),
    item("ToolResult", { seq: 6, createdAt: 150, tool: "finish_silently", body: { silent: true } }),
    item("AgentMessage", { seq: 7, createdAt: 160, text: "" }),
  ];
  const replies = itemsToMessages(items, MODEL).filter((m) => m.role === "assistant") as AssistantWork[];
  assert.deepEqual(replies.map((m) => (m.content[0] as { text: string }).text).filter(Boolean), ["The answer."]);
  assert.ok(replies.some((m) => activityItems(m.work?.activity ?? []).some((a) => a.tool === "finish_silently")));
});

test("steering retains intake identity, authors and attachments after history reload", () => {
  const messages = itemsToMessages([
    item("UserMessage", { seq: 1, createdAt: 1, text: "start" }),
    item("ToolCall", { seq: 2, createdAt: 2, tool: "read", callId: "a" }),
    item("ToolResult", { seq: 3, createdAt: 3, tool: "read", callId: "a" }),
    item("SteeringMessage", {
      seq: 4,
      createdAt: 4,
      text: "Use this instead",
      body: {
        name: "Alex",
        ts: "input-1",
        attachments: [{ name: "sample.png", mimetype: "image/png", artifactId: "image-1" }],
      },
    }),
    item("ToolCall", { seq: 5, createdAt: 5, tool: "read", callId: "b" }),
    item("ToolResult", { seq: 6, createdAt: 6, tool: "read", callId: "b" }),
    item("AgentMessage", { seq: 7, createdAt: 7, text: "Done" }),
  ]);
  const work = (messages.at(-1) as AssistantWork).work!;
  const timeline = messageWorkTimeline(work, "Done");
  assert.deepEqual(
    timeline.map((item) => item.kind),
    ["tool", "steer", "tool"],
  );
  assert.equal(timeline[1]?.kind === "steer" && timeline[1].item.seq, 4);
  const steer = messages[1] as unknown as {
    entrySeq: number;
    speaker: string;
    attachments: Array<{ artifactId: string }>;
  };
  assert.equal(steer.entrySeq, 4);
  assert.equal(steer.speaker, "Alex");
  assert.equal(steer.attachments[0]?.artifactId, "image-1");
});

test("live consumed steers join canonical history once and survive stopped/error fork accounting", () => {
  const items: Item[] = [
    item("UserMessage", { seq: 1, createdAt: 1, text: "start" }),
    item("ToolCall", { seq: 2, createdAt: 2, tool: "execute", callId: "a" }),
    item("SteeringMessage", { seq: 3, createdAt: 3, text: "Change direction" }),
    item("ToolResult", { seq: 4, createdAt: 4, tool: "execute", callId: "a" }),
    item("AgentMessage", { seq: 5, createdAt: 5, text: "(stopped)", body: { stopped: true } }),
  ];
  const work = (itemsToMessages(items).at(-1) as AssistantWork).work!;
  for (const reason of ["aborted", "error"] as const) {
    const live = itemsToMessages(items.slice(0, 1));
    appendConsumedSteers(live, work);
    appendConsumedSteers(live, work);
    assert.equal(live.length, 2);
    assert.equal((live[1] as { entrySeq?: number }).entrySeq, 3);
    live.push({ ...itemsToMessages(items).at(-1)!, stopReason: reason } as AgentMessage);
    assert.equal(forkCutSeq(items, live, live.length - 1), 5);
    assert.equal(forkCutSeq(items, live, 1), 3);
  }
});
