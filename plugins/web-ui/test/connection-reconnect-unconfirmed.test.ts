import assert from "node:assert/strict";
import test from "node:test";
import { connectWidget, harness, settle } from "./deep-link-boot-fixture.ts";

test("a reconnect that could not be confirmed says so on an app that is still connected", async () => {
  const h = await harness({
    path: "/s/sess-deep?composioReturn=return-nonce&status=failed&connectedAccountId=ca_test",
    connectionReturn: true,
    returnWidget: "reply:1:0:0",
    returnReplaces: "ca_old",
    api: (path) =>
      path.startsWith("/api/composio/connections")
        ? Response.json({ items: [{ id: "ca_old", toolkit: "gmail", missingScopes: [] }], nextCursor: null })
        : undefined,
  });
  try {
    await h.boot();
    const widget = connectWidget();
    const status = () => widget.querySelector(".connection-card-status")?.textContent?.trim();
    await settle(() => status() === "Couldn’t confirm the connection");
    assert.deepEqual(
      [...widget.querySelectorAll(".connection-card button")].map((button) => button.getAttribute("aria-label")),
      ["Reconnect Gmail", "Disconnect Gmail", "Check Gmail again"],
    );
  } finally {
    await h.close();
  }
});
