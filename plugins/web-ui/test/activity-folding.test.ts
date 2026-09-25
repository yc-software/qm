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
