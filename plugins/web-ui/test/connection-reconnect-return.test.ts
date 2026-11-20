import assert from "node:assert/strict";
import test from "node:test";
import { connectWidget, harness, settle } from "./deep-link-boot-fixture.ts";

test("a verified reconnect removes the replaced connection, and lists both when that fails", async () => {
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
      if (disconnects.length === 1) return new Response("busy", { status: 500 });
      items = items.filter((item) => item.id !== body.accountId);
      return Response.json({ disconnected: body.accountId, toolkit: "gmail" });
    },
  });
  try {
    await h.boot();
    const widget = connectWidget();
    const status = () => widget.querySelector(".connection-card-status")?.textContent?.trim();
    const rows = () => [...widget.querySelectorAll(".connection-connected > span")];
    await settle(() => rows().length === 2);
    assert.equal(status(), "Gmail is reconnected, but the old connection is still there. Disconnect it below.");
    assert.match(rows()[0]!.textContent ?? "", /Gmail needs new permissions/);
    assert.equal(widget.querySelector(".connection-card > .connection-card-actions .kc-text-action"), null);
    window.confirm = () => true;
    rows()[0]!.querySelector<HTMLButtonElement>(".kc-text-action.danger")!.click();
    await settle(() => status() === "Connected");
    assert.equal(status(), "Connected");
    assert.deepEqual(disconnects, [{ accountId: "ca_old" }, { accountId: "ca_old" }]);
    assert.equal(rows().length, 0);
    assert.ok(widget.querySelector(".connection-card.compact"));
  } finally {
    await h.close();
  }
});
