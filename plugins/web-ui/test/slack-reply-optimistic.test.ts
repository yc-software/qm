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

test("Slack chats show the composer before the connection check returns", async () => {
  let answer: (response: Response) => void = () => {};
  const h = await harness({
    path: "/",
    api: (path) =>
      path.endsWith("/slack/reply-status") ? new Promise<Response>((resolve) => (answer = resolve)) : undefined,
  });
  try {
    h.releaseSessions();
    await h.boot();
    h.releaseTranscript();
    await h.openSession(session);
    await until(() => !!document.querySelector("qm-slack-reply textarea"));
    assert.equal(h.requests.filter((path) => path.endsWith("/slack/reply-status")).length, 1);
    assert.doesNotMatch(document.querySelector("qm-slack-reply")!.textContent!, /Checking your Slack connection/);
    assert.match(
      document.querySelector("qm-slack-reply .composer-input")!.getAttribute("placeholder")!,
      /Reply in Slack as yourself/,
    );
    answer(Response.json({ connected: true, user: "Alice" }));
    await until(() =>
      /Reply in Slack as Alice/.test(
        document.querySelector("qm-slack-reply .composer-input")!.getAttribute("placeholder")!,
      ),
    );
    assert.equal(document.querySelector("qm-slack-reply .welcome-slack"), null);
  } finally {
    await h.close();
  }
});
