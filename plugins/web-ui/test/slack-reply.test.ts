import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

const session = {
  id: "slack-chat",
  threadRef: "ch:C123:123.456",
  surface: "slack",
  scopeId: "channel:C123",
  type: "channel" as const,
  createdAt: Date.now(),
  title: "Slack discussion",
};
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check());
}

test("Slack chats offer the account link once the check finds no link, rechecking on focus at most once a minute", async (t) => {
  let linked = false;
  const bodies: Array<Record<string, unknown>> = [];
  const h = await harness({
    path: "/",
    api: (path, init) => {
      if (!path.endsWith("/slack/reply-status")) return undefined;
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ connected: linked, user: "Alice" });
    },
  });
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  try {
    h.releaseSessions();
    await h.boot();
    h.releaseTranscript();
    await h.openSession(session);
    await until(() => !!document.querySelector("qm-slack-reply .welcome-slack"));
    assert.equal(document.querySelector("qm-slack-reply textarea"), null);
    assert.match(document.querySelector("qm-slack-reply")!.textContent!, /Send replies here as yourself/);
    linked = true;
    now += 30_000;
    window.dispatchEvent(new window.Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(bodies.length, 1);
    now += 30_000;
    window.dispatchEvent(new window.Event("focus"));
    await until(() => !!document.querySelector("qm-slack-reply textarea"));
    assert.equal(bodies.length, 2);
    assert.match(
      document.querySelector("qm-slack-reply .composer-input")!.getAttribute("placeholder")!,
      /Reply in Slack as Alice/,
    );
    assert.equal(document.querySelector(".chat-subtitle")!.textContent, "Slack");
  } finally {
    await h.close();
  }
});
