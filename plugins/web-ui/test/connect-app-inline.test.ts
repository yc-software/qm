import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

test("an app-scoped picker shows only the requested app and continues the chat after a verified return", async () => {
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
    document.querySelector(".message-stack")!.append(other, scoped, twin);
    for (let i = 0; i < 100 && sessionStorage.getItem("qm-connection-return:test:tester"); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(connected, ["Gmail"]);
    assert.match(scoped.querySelector("h3")?.textContent ?? "", /Connect Gmail/);
    assert.equal(scoped.querySelector('input[type="search"]'), null);
    assert.equal(scoped.querySelectorAll(".connection-picker-app").length, 1);
    assert.match(scoped.textContent ?? "", /Gmail connected/);
  } finally {
    await h.close();
  }
});
