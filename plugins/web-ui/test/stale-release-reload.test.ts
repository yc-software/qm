import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

test("a tab reloads onto a newly deployed release only once it regains focus with nothing in progress", async () => {
  let release = "release-a";
  const stamped = (body: unknown) => Response.json(body, { headers: { "x-qm-release": release } });
  const h = await harness({
    path: "/s/sess-deep",
    api: (path) => {
      if (path === "/me") return stamped({ user: "tester", org: "test", permissions: [] });
      if (path.startsWith("/api/sessions?")) return stamped({ sessions: [], pinned: [], nextCursor: null });
      return undefined;
    },
  });
  const realLocation = location;
  let reloads = 0;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    writable: true,
    value: new Proxy(
      {},
      {
        get: (_, key) => {
          if (key === "reload") return () => reloads++;
          const value = Reflect.get(realLocation, key, realLocation) as unknown;
          return typeof value === "function" ? value.bind(realLocation) : value;
        },
      },
    ),
  });
  const focus = () => window.dispatchEvent(new Event("focus"));
  document.head.insertAdjacentHTML("beforeend", '<meta name="qm-release" content="release-a" />');
  try {
    await h.boot();
    await h.refreshSessions();
    focus();
    assert.equal(reloads, 0);

    release = "release-b";
    await h.refreshSessions();
    const conversation = h.visibleConversation();
    conversation.composer.state.draft = "half-written reply";
    focus();
    assert.equal(reloads, 0);

    conversation.composer.state.draft = "";
    conversation.state.pendingSend = "sending";
    focus();
    assert.equal(reloads, 0);

    conversation.state.pendingSend = null;
    const editor = document.createElement("textarea");
    document.body.append(editor);
    editor.value = "unsaved cron task";
    editor.focus();
    focus();
    assert.equal(reloads, 0);

    editor.remove();
    const form = document.createElement("form");
    form.setAttribute("aria-modal", "true");
    document.body.append(form);
    focus();
    assert.equal(reloads, 0);

    form.remove();
    focus();
    assert.equal(reloads, 1);

    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(reloads, 2);
  } finally {
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: realLocation });
    await h.close();
  }
});
