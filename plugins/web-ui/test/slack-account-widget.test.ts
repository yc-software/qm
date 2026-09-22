import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

test("recalled personal Slack widget renders independently and respects installation", async () => {
  const h = await harness({ path: "/", welcome: true });
  const previousFetch = globalThis.fetch;
  let installed = true;
  globalThis.fetch = async (input, init) =>
    String(input) === "/api/composio/slack"
      ? Response.json({ workspaceInstalled: installed, connected: false })
      : previousFetch(input, init);
  try {
    h.releaseSessions();
    await h.boot();
    const widget = Object.assign(document.createElement("qm-onboarding-welcome"), {
      me: { org: "test", user: "tester", permissions: ["admin"] },
      widget: "slack-account",
      setupOnly: true,
      animateWelcome: false,
    });
    document.body.append(widget);
    for (let i = 0; i < 100 && !widget.querySelector("qm-slack-account"); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(widget.querySelector("qm-slack-account"));
    assert.equal(widget.querySelector("qm-onboarding-slack"), null);
    assert.equal(widget.querySelector(".welcome-picker"), null);
    installed = false;
    window.dispatchEvent(new window.Event("focus"));
    for (let i = 0; i < 100 && widget.querySelector("qm-slack-account"); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(widget.textContent ?? "", /needs to be added/);
    assert.equal(widget.querySelector("qm-slack-account"), null);
  } finally {
    globalThis.fetch = previousFetch;
    await h.close();
  }
});
