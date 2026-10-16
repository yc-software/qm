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

test("Slack composer posts to the Slack endpoint and retains text after a rejected send", async () => {
  const messages: unknown[] = [];
  let succeed = false;
  const h = await harness({
    path: "/",
    api: (path, init) => {
      if (path.endsWith("/slack/reply-status")) return Response.json({ connected: true, user: "Alice" });
      if (path.endsWith("/slack/reply")) {
        messages.push(JSON.parse(String(init?.body)));
        return succeed
          ? Response.json({ sent: true })
          : Response.json({ message: "Slack denied this message." }, { status: 403 });
      }
      return undefined;
    },
  });
  const originalCustomEvent = globalThis.CustomEvent;
  globalThis.CustomEvent = window.CustomEvent;
  try {
    h.releaseSessions();
    await h.boot();
    h.releaseTranscript();
    await h.openSession(session);
    await until(() => !!document.querySelector("qm-slack-reply textarea"));
    const widget = document.querySelector("qm-slack-reply")!;
    widget.addEventListener("slack-sent", (e) => e.stopPropagation());
    const field = widget.querySelector("textarea")!;
    field.value = "Hello Slack";
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
    await h.openSession(session);
    assert.equal(document.querySelector("qm-slack-reply"), widget);
    assert.equal(field.value, "Hello Slack");
    field.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, cancelable: true }));
    field.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, cancelable: true }));
    assert.equal(messages.length, 0);
    field.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    await until(() => !!widget.querySelector('[role="alert"]'));
    assert.equal(field.value, "Hello Slack");
    assert.equal(messages.length, 1);
    assert.deepEqual(Object.keys(messages[0] as object).sort(), ["clientMessageId", "sessionId", "text"]);
    succeed = true;
    widget.querySelector("form")!.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await until(() => field.value === "");
    assert.doesNotMatch(widget.textContent!, /Sending to Slack|Sent to Slack/);
    assert.equal(widget.querySelector('[role="alert"]'), null);
    assert.equal(messages.length, 2);
    assert.equal(
      h.requests.some((path) => path === "/api/turn"),
      false,
    );
  } finally {
    globalThis.CustomEvent = originalCustomEvent;
    await h.close();
  }
});
