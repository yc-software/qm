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
    const widget = Object.assign(document.createElement("qm-connect-apps"), {
      me: { org: "test", user: "tester" },
      widget: "apps",
      toolkit: "gmail",
      returnKey: "reply:1:0:0",
    });
    document.querySelector(".message-stack")!.append(widget);
    for (let i = 0; i < 200 && !/wasn’t connected/.test(widget.textContent ?? ""); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.match(widget.textContent ?? "", /Gmail wasn’t connected/);
    assert.match(widget.textContent ?? "", /Gmail needs new permissions/);
    assert.deepEqual(disconnects, []);
  } finally {
    await h.close();
  }
});
