import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

test("a cancelled reconnect leaves the existing connection in place", async () => {
  const disconnects: string[] = [];
  const h = await harness({
    path: "/s/sess-deep?composioReturn=return-nonce&status=failed&error=access_denied&connectedAccountId=ca_test",
    connectionReturn: true,
    returnWidget: "reply:1:0:0",
    returnReplaces: "ca_old",
    api: (path) => {
      if (path.startsWith("/api/composio/connections"))
        return Response.json({ items: [{ id: "ca_old", toolkit: "gmail", missingScopes: ["gmail.send"] }] });
      if (path === "/api/composio/disconnect") disconnects.push(path);
      return undefined;
    },
  });
  try {
    await h.boot();
    const widget = Object.assign(document.createElement("qm-onboarding-welcome"), {
      me: { org: "test", user: "tester" },
      widget: "apps",
      setupOnly: true,
      toolkit: "gmail",
      returnKey: "reply:1:0:0",
    });
    document.querySelector(".message-stack")!.append(widget);
    for (let i = 0; i < 200 && sessionStorage.getItem("qm-connection-return:test:tester"); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(widget.querySelector(".connection-card-status")?.textContent?.trim(), "Needs new permissions");
    assert.equal(widget.querySelector(".connection-card .btn.primary")?.getAttribute("aria-label"), "Reconnect Gmail");
    assert.deepEqual(disconnects, []);
  } finally {
    await h.close();
  }
});
