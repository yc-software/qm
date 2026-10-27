import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

test("personal Slack linking appears beneath the confirmed company installation", async () => {
  const h = await harness({ path: "/" });
  const previousFetch = globalThis.fetch;
  let installed = false;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/me") return Response.json({ user: "tester", org: "test", permissions: ["admin"] });
    if (String(input) === "/admin/api/slack-installation")
      return Response.json({ configured: installed, installAvailable: true, setup: { connected: installed } });
    return previousFetch(input, init);
  };
  try {
    h.releaseSessions();
    await h.boot();
    const widget = Object.assign(document.createElement("qm-connect-apps"), {
      me: { org: "test", user: "tester", permissions: ["admin"] },
      widget: "slack",
      adminBase: "/admin",
    });
    document.body.append(widget);
    for (let i = 0; i < 100 && !(widget.textContent ?? "").includes("Add to Slack"); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(widget.textContent ?? "", /Add to Slack/);
    assert.equal(document.querySelector("qm-slack-account"), null);
    installed = true;
    window.dispatchEvent(new window.Event("focus"));
    for (let i = 0; i < 100 && !(widget.textContent ?? "").includes("Link your Slack account"); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(widget.textContent ?? "", /QM added to Slack/);
    assert.match(widget.textContent ?? "", /Link your Slack account/);
    assert.ok(
      (widget.textContent ?? "").indexOf("QM added to Slack") <
        (widget.textContent ?? "").indexOf("Link your Slack account"),
    );
    assert.equal(document.querySelector("qm-onboarding-slack button.slack-connect"), null);
    installed = false;
    window.dispatchEvent(new window.Event("focus"));
    for (let i = 0; i < 100 && document.querySelector("qm-slack-account"); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(document.querySelector("qm-slack-account"), null);
  } finally {
    globalThis.fetch = previousFetch;
    await h.close();
  }
});
