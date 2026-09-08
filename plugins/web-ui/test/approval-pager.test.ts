import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { PendingApproval, SessionEntry } from "../src/core-bridge.ts";
import { bootConversation, until } from "./dom-harness.ts";

test("the composer pages through pending approvals one card at a time", async () => {
  const approvals: PendingApproval[] = ["rm -rf build", "git push --force", "npm publish"].map((command, i) => ({
    requestId: `a${i + 1}`,
    command,
    reason: "requires approval",
  }));
  const entries: SessionEntry[] = [{ seq: 1, type: "user", createdAt: Date.now(), payload: { text: "ship it" } }];
  const boot = await bootConversation({ entries, approvals });
  const { conv, host } = boot;
  try {
    boot.mount();
    await until(() => !!conv.composer.currentModelOption() && !!host.querySelector(".approval-pager-count"));

    const panel = () => host.querySelector(".composer-approval-panel")!;
    const count = () => panel().querySelector(".approval-pager-count")?.textContent?.trim();
    const shown = () => [...panel().querySelectorAll(".approval-cmd")].map((el) => el.textContent?.trim());
    const pagerButton = (label: string) => panel().querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;

    assert.equal(count(), "1/3");
    assert.deepEqual(shown(), ["rm -rf build"]);
    assert.equal(pagerButton("Previous approval").disabled, true);

    pagerButton("Next approval").click();
    await until(() => count() === "2/3");
    assert.deepEqual(shown(), ["git push --force"]);
    assert.equal(pagerButton("Previous approval").disabled, false);

    pagerButton("Next approval").click();
    await until(() => count() === "3/3");
    assert.deepEqual(shown(), ["npm publish"]);
    assert.equal(pagerButton("Next approval").disabled, true);
    assert.equal(panel().querySelectorAll(".approval-btn").length, 4);
  } finally {
    await boot.dispose();
  }
});

test("the pager index resets with the composer so a new conversation opens on its first approval", () => {
  const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
  assert.match(composer, /function resetComposer\(\)[\s\S]*?approvalPage = 0;/);
});
