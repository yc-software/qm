import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

test("A verified Slack install from a chat card continues the conversation once", async () => {
  const h = await harness({ path: "/", welcome: true });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/admin/slack-installation")
      return Response.json({ configured: false, installAvailable: true });
    return previousFetch(input, init);
  };
  const continued: string[] = [];
  let card: HTMLElement | undefined;
  const props = {
    me: { user: "admin@example.com", org: "acme", permissions: ["admin"] },
    widget: "slack",
    setupOnly: true,
    animateWelcome: false,
    returnKey: "reply:1:0",
    onConnected: (name: string) => continued.push(name),
  };
  try {
    h.releaseSessions();
    await h.boot();
    card = Object.assign(document.createElement("qm-onboarding-welcome"), props);
    document.body.append(card);
    for (let i = 0; i < 100 && !card.querySelector("qm-onboarding-slack"); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const slack = card.querySelector("qm-onboarding-slack")!;
    slack.dispatchEvent(new window.CustomEvent("slack-installed", { bubbles: true }));
    slack.dispatchEvent(new window.CustomEvent("slack-installed", { bubbles: true }));
    assert.deepEqual(continued, ["Slack"]);
  } finally {
    card?.remove();
    globalThis.fetch = previousFetch;
    await h.close();
  }
});
