import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

for (const count of [1, 2]) {
  test(`${count} tool items use only useful activity folds`, async () => {
    const entries = Array.from({ length: count }, (_, index) => [
      {
        seq: index * 2,
        type: "tool_call",
        createdAt: 1000,
        payload: { tool: "execute", callId: String(index), command: `echo ${index}` },
      },
      {
        seq: index * 2 + 1,
        type: "tool_result",
        createdAt: 2000,
        payload: { tool: "execute", callId: String(index), code: 0, stdout: String(index) },
      },
    ]).flat();
    const h = await harness({ path: `/s/${SESSION.id}`, listSessions: [SESSION], entries });
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
  const parent = { ...SESSION, id: "parent", title: "Build report" };
  const h = await harness({
    path: `/s/${SESSION.id}`,
    listSessions: [parent, { ...SESSION, parentSessionId: parent.id }],
  });
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
    {
      seq,
      type: "tool_call",
      createdAt: seq * 1000,
      payload: { tool: "execute", callId: String(seq), command: `echo step-${seq}` },
    },
    {
      seq: seq + 1,
      type: "tool_result",
      createdAt: (seq + 1) * 1000,
      payload: { tool: "execute", callId: String(seq), code: 0, stdout: String(seq) },
    },
  ];
  const entries = [
    { seq: 0, type: "user", createdAt: 0, payload: { text: "Original request" } },
    ...tool(1),
    ...tool(3),
    { seq: 5, type: "user", createdAt: 5000, payload: { text: "Use the smaller sample", steered: true } },
    ...tool(6),
    ...tool(8),
    { seq: 10, type: "assistant", createdAt: 10000, payload: { text: "Done" } },
  ];
  const h = await harness({ path: `/s/${SESSION.id}`, listSessions: [SESSION], entries });
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
    assert.equal(document.querySelector(".inline-steer .speaker-label")?.textContent, "Another person");
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
  const entries = [
    { seq: 0, type: "user", createdAt: 0, payload: { text: "Original request" } },
    { seq: 1, type: "tool_call", createdAt: 1000, payload: { tool: "execute", callId: "a", command: "echo before" } },
    { seq: 2, type: "tool_result", createdAt: 2000, payload: { tool: "execute", callId: "a", code: 0 } },
    { seq: 3, type: "user", createdAt: 3000, payload: { text: "Change direction", steered: true } },
    { seq: 4, type: "tool_call", createdAt: 4000, payload: { tool: "execute", callId: "b", command: "echo after" } },
    { seq: 5, type: "tool_result", createdAt: 5000, payload: { tool: "execute", callId: "b", code: 0 } },
    { seq: 6, type: "assistant", createdAt: 6000, payload: { text: "(stopped)", stopped: true } },
  ];
  const h = await harness({ path: `/s/${SESSION.id}`, listSessions: [SESSION], entries });
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
