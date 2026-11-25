import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

test("a card for one app shows only that app and continues the chat after a verified return", async () => {
  const h = await harness({
    path: "/s/sess-deep?composioReturn=return-nonce&status=success&connectedAccountId=ca_test",
    connectionReturn: true,
    returnWidget: "reply:1:0:0",
  });
  try {
    await h.boot();
    const connected: string[] = [];
    const other = Object.assign(document.createElement("qm-onboarding-welcome"), {
      me: { org: "test", user: "tester" },
      widget: "apps",
      setupOnly: true,
      toolkit: "notion",
      returnKey: "reply:0:0:0",
      onConnected: (name: string) => connected.push(`other:${name}`),
    });
    const scoped = Object.assign(document.createElement("qm-onboarding-welcome"), {
      me: { org: "test", user: "tester" },
      widget: "apps",
      setupOnly: true,
      toolkit: "gmail",
      returnKey: "reply:1:0:0",
      onConnected: (name: string) => connected.push(name),
    });
    const twin = Object.assign(document.createElement("qm-onboarding-welcome"), {
      me: { org: "test", user: "tester" },
      widget: "apps",
      setupOnly: true,
      toolkit: "gmail",
      returnKey: "reply:1:0:0",
      onConnected: (name: string) => connected.push(`twin:${name}`),
    });
    const g = Object.assign(document.createElement("qm-onboarding-welcome"), { widget: "apps", toolkit: "granola" });
    document.querySelector(".message-stack")!.append(other, scoped, twin, g);
    for (let i = 0; i < 100 && sessionStorage.getItem("qm-connection-return:test:tester"); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(connected, ["Gmail"]);
    assert.equal(scoped.querySelector(".connection-card strong")?.textContent, "Gmail");
    assert.equal(scoped.querySelector(".connection-card-status")?.textContent?.trim(), "Connected");
    assert.deepEqual(
      [...scoped.querySelectorAll(".connection-card button")].map((button) => button.getAttribute("aria-label")),
      ["Reconnect Gmail", "Disconnect Gmail"],
    );
    assert.equal(scoped.querySelector('input[type="search"]'), null);
    assert.equal(scoped.querySelector(".connection-picker"), null);
    assert.equal(g.querySelector(".connection-card strong")?.textContent, "Granola MCP");
    assert.ok(other.querySelector(".connection-picker"), "an app the catalog does not have falls back to the picker");
  } finally {
    await h.close();
  }
});
