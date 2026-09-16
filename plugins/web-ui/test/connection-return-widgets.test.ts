import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

test("a recalled app picker owns its return even when welcome and Slack widgets mount first", async () => {
  const h = await harness({
    path: "/s/sess-deep?composioReturn=return-nonce&status=success&connectedAccountId=ca_test",
    welcome: true,
    connectionReturn: true,
    returnWidget: "reply:1:0:0",
  });
  try {
    await h.boot();
    const welcome = document.querySelector("qm-onboarding-welcome")!;
    const slack = Object.assign(document.createElement("qm-onboarding-welcome"), {
      me: { org: "test", user: "tester" },
      widget: "slack",
      setupOnly: true,
      returnKey: "reply:0:0:0",
    });
    document.querySelector(".message-stack")!.append(slack);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.notEqual(sessionStorage.getItem("qm-connection-return:test:tester"), null);
    assert.equal((welcome.querySelector('input[type="search"]') as HTMLInputElement)?.value, "");
    const apps = Object.assign(document.createElement("qm-onboarding-welcome"), {
      me: { org: "test", user: "tester" },
      widget: "apps",
      setupOnly: true,
      returnKey: "reply:1:0:0",
    });
    document.querySelector(".message-stack")!.append(apps);
    for (let i = 0; i < 100 && sessionStorage.getItem("qm-connection-return:test:tester"); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(sessionStorage.getItem("qm-connection-return:test:tester"), null);
    assert.equal((apps.querySelector('input[type="search"]') as HTMLInputElement)?.value, "mail");
    assert.equal((welcome.querySelector('input[type="search"]') as HTMLInputElement)?.value, "");
    assert.match(apps.textContent ?? "", /Gmail connected/);
  } finally {
    await h.close();
  }
});
