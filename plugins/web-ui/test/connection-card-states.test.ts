import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

const settle = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

test("a card says in one line why an app isn't connected and what to do next", async () => {
  const h = await harness({
    path: "/s/sess-deep?composioReturn=return-nonce&status=failed&error=access_denied&connectedAccountId=ca_test",
    connectionReturn: true,
    returnWidget: "reply:1:0:0",
  });
  try {
    await h.boot();
    h.setConnections([]);
    const widget = Object.assign(document.createElement("qm-onboarding-welcome"), {
      me: { org: "test", user: "tester" },
      widget: "apps",
      setupOnly: true,
      toolkit: "gmail",
      returnKey: "reply:1:0:0",
    });
    document.querySelector(".message-stack")!.append(widget);
    const status = () => widget.querySelector(".connection-card-status")?.textContent?.trim();
    const primary = () => widget.querySelector(".connection-card .btn.primary")?.getAttribute("aria-label");
    await settle(() => status() === "Sign-in cancelled");
    assert.equal(primary(), "Connect Gmail");

    Object.assign(widget, { connectionOutcome: "failed" });
    await settle(() => status() === "Couldn’t confirm the connection");
    assert.equal(primary(), "Try again Gmail");
    assert.equal(widget.querySelector(".connection-card")?.getAttribute("data-tone"), "error");

    h.setConnections([], 502);
    window.dispatchEvent(new Event("focus"));
    await settle(() => /Could not check connected apps/.test(status() ?? ""));
    const retry = widget.querySelector<HTMLButtonElement>(".connection-card .btn:not(.primary)")!;
    assert.equal(retry.getAttribute("aria-label"), "Check again Gmail");
    h.setConnections([{ id: "ca_test", toolkit: "gmail", missingScopes: [] }]);
    retry.click();
    await settle(() => status() === "Connected");
    assert.equal(primary(), undefined);
  } finally {
    await h.close();
  }
});
