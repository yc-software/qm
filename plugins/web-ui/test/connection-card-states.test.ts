import assert from "node:assert/strict";
import test from "node:test";
import { connectWidget, harness, settle } from "./deep-link-boot-fixture.ts";

test("a card says in one line why an app isn't connected and what to do next", async () => {
  const h = await harness({
    path: "/s/sess-deep?composioReturn=return-nonce&status=failed&connectedAccountId=ca_test",
    connectionReturn: true,
    returnWidget: "reply:1:0:0",
  });
  try {
    await h.boot();
    h.setConnections([]);
    const widget = connectWidget();
    const status = () => widget.querySelector(".connection-card-status")?.textContent?.trim();
    const primary = () => widget.querySelector(".connection-card .btn.primary")?.getAttribute("aria-label");
    const recheck = () => widget.querySelector<HTMLButtonElement>(".connection-card .btn:not(.primary)");
    await settle(() => status() === "Couldn’t confirm the connection");
    assert.equal(primary(), "Try connecting Gmail again");
    assert.equal(recheck()?.getAttribute("aria-label"), "Check Gmail again");
    assert.equal(widget.querySelector(".connection-card")?.getAttribute("data-tone"), "error");

    h.setConnections([], 502);
    window.dispatchEvent(new Event("focus"));
    await settle(() => status() === "Could not check connected apps. Please try again.");
    const retry = recheck()!;
    assert.equal(retry.getAttribute("aria-label"), "Check Gmail again");
    assert.equal(primary(), undefined);
    h.setConnections([{ id: "ca_test", toolkit: "gmail", missingScopes: [] }]);
    retry.click();
    await settle(() => status() === "Connected");
    assert.equal(primary(), undefined);
  } finally {
    await h.close();
  }
});
