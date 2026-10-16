import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./deep-link-boot-fixture.ts";

test("webhook worklogs retain their title without appearing in the session bar", async () => {
  const h = await harness({
    path: "/",
    listSessions: [
      {
        id: "untitled-hook",
        threadRef: "external:untitled",
        scopeId: "personal:tester",
        surface: "webhook",
        type: "dm",
        createdAt: Date.now(),
        title: null,
      },
      {
        id: "named-hook",
        threadRef: "external:named",
        scopeId: "personal:tester",
        surface: "webhook",
        type: "dm",
        createdAt: Date.now(),
        title: "Review deployments",
      },
    ],
  });
  try {
    h.releaseSessions();
    await h.boot();
    h.setWebOnly(false);
    await h.refreshSessions();
    h.releaseTranscript();
    await h.openSession({
      id: "untitled-hook",
      threadRef: "external:untitled",
      scopeId: "personal:tester",
      surface: "webhook",
      type: "dm",
      createdAt: Date.now(),
      title: null,
    });
    assert.match(h.mainText(), /Webhook run/);
    assert.equal(document.querySelector('.session-row a[href="/s/untitled-hook"]'), null);
    assert.equal(document.querySelector('.session-row a[href="/s/named-hook"]'), null);
    await h.openSession({
      id: "named-hook",
      threadRef: "external:named",
      scopeId: "personal:tester",
      surface: "webhook",
      type: "dm",
      createdAt: Date.now(),
      title: "Review deployments",
    });
    assert.match(h.mainText(), /Review deployments/);
    assert.equal(document.querySelector('.session-row a[href="/s/named-hook"]'), null);
  } finally {
    await h.close();
  }
});
