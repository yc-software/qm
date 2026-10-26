import { item } from "./item-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

for (const count of [1, 2]) {
  test(`${count} tool items use only useful activity folds`, async () => {
    const items = Array.from({ length: count }, (_, index) => [
      item("ToolCall", {
        seq: index * 2,
        createdAt: 1000,
        tool: "execute",
        callId: String(index),
        body: { command: `echo ${index}` },
      }),
      item("ToolResult", {
        seq: index * 2 + 1,
        createdAt: 2000,
        tool: "execute",
        callId: String(index),
        text: String(index),
        body: { code: 0 },
      }),
    ]).flat();
    const h = await harness({ path: `/s/${SESSION.id}`, listSessions: [SESSION], items });
    try {
      h.releaseSessions();
      await h.boot();
      await h.sessionsReady();
      assert.equal(document.querySelectorAll(".tool-expandable").length, count);
      assert.equal(document.querySelectorAll(".work-fold").length, count === 1 ? 0 : 2);
      const tool = document.querySelector<HTMLDetailsElement>(".tool-expandable")!;
      tool.open = true;
      tool.dispatchEvent(new Event("toggle"));
      assert.match(tool.textContent!, /echo 0/);
    } finally {
      await h.close();
    }
  });
}

test("a subagent header includes its parent title in the breadcrumb", async () => {
  const parent = { ...SESSION, id: "parent", threadRef: "web:tester:parent", title: "Build report" };
  const child = { ...SESSION, type: "dm" as const, createdAt: 1, parentSessionId: parent.id };
  const h = await harness({ path: `/s/${SESSION.id}`, session: child, listSessions: [parent, child] });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    const crumb = document.querySelector<HTMLButtonElement>(".split-pane-parent");
    assert.equal(crumb?.textContent?.trim(), "Build report");
    assert.equal(crumb?.getAttribute("aria-label"), "Back to parent: Build report");
  } finally {
    await h.close();
  }
});

test("steering separates tool folds with a visible unlabelled user message", async () => {
  const tool = (seq: number) => [
    item("ToolCall", {
      seq,
      createdAt: seq * 1000,
      tool: "execute",
      callId: String(seq),
      body: { command: `echo step-${seq}` },
    }),
    item("ToolResult", {
      seq: seq + 1,
      createdAt: (seq + 1) * 1000,
      tool: "execute",
      callId: String(seq),
      text: String(seq),
      body: { code: 0 },
    }),
  ];
  const items = [
    item("UserMessage", { seq: 0, createdAt: 0, text: "Original request" }),
    ...tool(1),
    ...tool(3),
    item("SteeringMessage", { seq: 5, createdAt: 5000, text: "Use the smaller sample" }),
    ...tool(6),
    ...tool(8),
    item("AgentMessage", { seq: 10, createdAt: 10000, text: "Done" }),
  ];
  const h = await harness({ path: `/s/${SESSION.id}`, listSessions: [SESSION], items });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    const steer = document.querySelector(".inline-steer")!;
    assert.equal(document.querySelectorAll(".inline-steer").length, 1);
    assert.equal(document.querySelectorAll(".message-stack > .steered-row").length, 0);
    assert.equal(
      steer.querySelector<HTMLElement & { content: string }>("qm-markdown")?.content,
      "Use the smaller sample",
    );
    assert.equal(steer.closest("details"), null);
    assert.equal(document.querySelector(".steer-label"), null);
    assert.doesNotMatch(document.body.textContent!, /steered the running task/);
    const folds = [...document.querySelectorAll(".work.work-fold")];
    assert.equal(folds.length, 2);
    assert.match(folds[0]!.textContent!, /step-1/);
    assert.match(folds[1]!.textContent!, /step-6/);
    assert.ok(folds[0]!.compareDocumentPosition(steer) & Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(steer.compareDocumentPosition(folds[1]!) & Node.DOCUMENT_POSITION_FOLLOWING);
    const conv = h.visibleConversation();
    const user = conv.state.agent!.state.messages.find(
      (message) => (message as { entrySeq?: number }).entrySeq === 5,
    ) as unknown as { speaker: string; edited: boolean; deleted: boolean };
    (conv.state.agent!.state.messages[0] as unknown as { speaker: string }).speaker = "Requester";
    user.speaker = "Another person";
    user.edited = true;
    conv.drawActiveChat();
    assert.match(document.querySelector(".inline-steer .speaker-label")?.textContent ?? "", /AP\s+another/);
    assert.equal(document.querySelector(".inline-steer .revision-badge")?.textContent, "(edited)");
    user.deleted = true;
    conv.drawActiveChat();
    assert.equal(document.querySelector(".inline-steer .revision-badge")?.textContent, "(deleted)");
    (conv.state.agent!.state.messages.at(-1) as unknown as { approvalDecision: string }).approvalDecision = "denied";
    conv.drawActiveChat();
    assert.equal(document.querySelectorAll(".tool-expandable").length, 0);
    assert.equal(document.querySelectorAll(".inline-steer").length, 1);
  } finally {
    await h.close();
  }
});

test("stopping a steered run preserves earlier singleton tools and labels only its last segment stopped", async () => {
  const items = [
    item("UserMessage", { seq: 0, createdAt: 0, text: "Original request" }),
    item("ToolCall", { seq: 1, createdAt: 1000, tool: "execute", callId: "a", body: { command: "echo before" } }),
    item("ToolResult", { seq: 2, createdAt: 2000, tool: "execute", callId: "a", body: { code: 0 } }),
    item("SteeringMessage", { seq: 3, createdAt: 3000, text: "Change direction" }),
    item("ToolCall", { seq: 4, createdAt: 4000, tool: "execute", callId: "b", body: { command: "echo after" } }),
    item("ToolResult", { seq: 5, createdAt: 5000, tool: "execute", callId: "b", body: { code: 0 } }),
    item("AgentMessage", { seq: 6, createdAt: 6000, text: "(stopped)", body: { stopped: true } }),
  ];
  const h = await harness({ path: `/s/${SESSION.id}`, listSessions: [SESSION], items });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    const tools = [...document.querySelectorAll(".tool-expandable")];
    assert.equal(tools.length, 2);
    assert.equal(tools[0]!.closest(".work-fold, .stopped-work"), null);
    assert.equal(document.querySelectorAll(".stopped-work").length, 1);
    assert.ok(tools[1]!.closest(".stopped-work"));
    assert.equal(document.querySelectorAll(".stopped-head").length, 1);
    assert.equal(document.querySelector(".inline-steer")!.closest("details"), null);
  } finally {
    await h.close();
  }
});

test("a steer the model has not read shows once in the transcript, then once inside the work", async () => {
  const items = [
    item("UserMessage", { seq: 0, createdAt: 0, text: "Original request" }),
    item("ToolCall", { seq: 1, createdAt: 1000, tool: "execute", callId: "a", body: { command: "echo a" } }),
    item("ToolResult", { seq: 2, createdAt: 2000, tool: "execute", callId: "a", body: { code: 0 } }),
  ];
  const h = await harness({ path: `/s/${SESSION.id}`, listSessions: [SESSION], items });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    const conv = h.visibleConversation();
    let waiting = [{ runId: "q1", text: "Use the smaller sample" }];
    conv.composer.waitingSteers = () => waiting;
    conv.drawActiveChat();
    const row = document.querySelector(".message-stack > .waiting-steer")!;
    assert.ok(row);
    assert.equal(document.querySelectorAll(".inline-steer").length, 1);
    assert.ok(row.querySelector(".steered-row .user-bubble"));
    assert.equal(
      row.querySelector<HTMLElement & { content: string }>("qm-markdown")?.content,
      "Use the smaller sample",
    );
    assert.equal(document.querySelector(".queued-chip"), null);
    waiting = [];
    conv.state.agent!.state.messages.push({
      role: "user",
      content: "Use the smaller sample",
      steered: true,
      entrySeq: 3,
      timestamp: 3000,
    } as never);
    conv.drawActiveChat();
    assert.equal(document.querySelectorAll(".waiting-steer").length, 0);
    assert.equal(document.querySelectorAll(".message-stack > .steered-row").length, 0);
  } finally {
    await h.close();
  }
});
