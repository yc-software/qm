import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

test("a verified reconnect removes the replaced connection only after the new one is active", async () => {
  const disconnects: unknown[] = [];
  let items = [
    { id: "ca_old", toolkit: "gmail", missingScopes: ["gmail.send"] },
    { id: "ca_test", toolkit: "gmail", missingScopes: [] },
  ];
  const h = await harness({
    path: "/s/sess-deep?composioReturn=return-nonce&status=success&connectedAccountId=ca_test",
    connectionReturn: true,
    returnWidget: "reply:1:0:0",
    returnReplaces: "ca_old",
    api: (path, init) => {
      if (path.startsWith("/api/composio/connections")) return Response.json({ items, nextCursor: null });
      if (path !== "/api/composio/disconnect") return undefined;
      const body = JSON.parse(String(init?.body));
      disconnects.push(body);
      items = items.filter((item) => item.id !== body.accountId);
      return Response.json({ disconnected: body.accountId, toolkit: "gmail" });
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
    for (let i = 0; i < 200 && !(disconnects.length && /Gmail connected/.test(widget.textContent ?? "")); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(disconnects, [{ accountId: "ca_old" }]);
    assert.equal(widget.querySelectorAll(".connection-connected > span").length, 1);
    assert.doesNotMatch(widget.textContent ?? "", /needs new permissions/);
  } finally {
    await h.close();
  }
});
