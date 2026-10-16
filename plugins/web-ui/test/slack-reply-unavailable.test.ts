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

test("unavailable Slack linking shows one explanation and recovers when configured", async () => {
  let configured = false;
  const h = await harness({
    path: "/",
    api: (path) => {
      if (!path.endsWith("/slack/reply-status")) return undefined;
      if (configured) return Response.json({ connected: false });
      return Response.json({ error: "composio_unavailable", message: "App connections unavailable" }, { status: 403 });
    },
  });
  try {
    h.releaseSessions();
    await h.boot();
    h.releaseTranscript();
    await h.openSession(session);
    await until(() => !!document.querySelector("qm-slack-reply [role=alert]"));
    const reply = document.querySelector("qm-slack-reply")!;
    assert.equal(reply.querySelector("qm-slack-account"), null);
    assert.equal(reply.querySelectorAll("[role=alert]").length, 1);
    assert.match(reply.textContent!, /Slack linking isn’t configured/);
    configured = true;
    (reply.querySelector("button") as HTMLButtonElement).click();
    await until(() => !!reply.querySelector(".welcome-slack"));
    assert.equal(reply.querySelector("[role=alert]"), null);
  } finally {
    await h.close();
  }
});
