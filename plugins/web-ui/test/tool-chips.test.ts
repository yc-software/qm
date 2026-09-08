import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "../src/core-bridge.ts";
import { bootConversation, until } from "./dom-harness.ts";

test("tool rows render their label beside a mono detail chip, tinted by outcome", async () => {
  const entries: SessionEntry[] = [
    { seq: 1, type: "user", createdAt: 1, payload: { text: "ship it" } },
    { seq: 2, parentSeq: 1, type: "tool_call", createdAt: 2, payload: { tool: "execute", command: "npm run freeze" } },
    { seq: 3, parentSeq: 2, type: "tool_result", createdAt: 3, payload: { tool: "execute", code: 0, stdout: "ok" } },
    { seq: 4, parentSeq: 1, type: "tool_call", createdAt: 4, payload: { tool: "write", path: "ChurnSchedule.tsx" } },
    { seq: 5, parentSeq: 4, type: "tool_result", createdAt: 5, payload: { tool: "write", error: "read-only" } },
    { seq: 6, parentSeq: 1, type: "tool_call", createdAt: 6, payload: { tool: "recall" } },
    { seq: 7, parentSeq: 6, type: "tool_result", createdAt: 7, payload: { tool: "recall" } },
    { seq: 8, type: "assistant", createdAt: 8, payload: { text: "done" } },
  ];
  const boot = await bootConversation({ entries });
  const { host } = boot;
  try {
    boot.mount();
    await until(() => host.querySelectorAll(".tool-row").length === 3);

    const ok = host.querySelector(".tool-row.tool-ok")!;
    assert.equal(ok.querySelector(".tool-name")?.textContent, "Ran command");
    const chip = ok.querySelector(".tool-label.tool-chip")!;
    assert.equal(chip.textContent, "npm run freeze");
    assert.equal(chip.getAttribute("title"), "Ran command: npm run freeze");
    assert.ok(ok.querySelector(".tool-icon svg"), "settled rows keep their tool glyph");

    const failed = host.querySelector(".tool-row.tool-failed")!;
    assert.equal(failed.querySelector(".tool-name")?.textContent, "Tried writing file");
    assert.equal(failed.querySelector(".tool-chip")?.textContent, "ChurnSchedule.tsx · read-only");

    const bare = host.querySelector(".tool-row.tool-ok:has(.tool-label:not(.tool-chip))")!;
    assert.equal(bare.querySelector(".tool-name"), null, "a row without detail shows only its label");
    assert.equal(bare.querySelector(".tool-label")?.textContent, "Searched memory");
  } finally {
    await boot.dispose();
  }
});
