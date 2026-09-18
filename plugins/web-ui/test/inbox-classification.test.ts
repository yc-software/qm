import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("inbox classification matches the backend for top-level and payload-only sources", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  for (const key of ["window", "document", "location", "history", "localStorage", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "window" ? dom.window : dom.window[key as keyof typeof dom.window],
    });
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { toInboxItem, inboxState, itemsFor, inboxOpenCount, draftEditorTpl } =
      await vite.ssrLoadModule("/src/inbox.ts");
    const { render } = await vite.ssrLoadModule("lit");
    const host = dom.window.document.getElementById("main")!;
    for (const source of ["gmail", "slack"]) {
      const other = source === "gmail" ? "slack" : "gmail";
      for (const fields of [
        { source, payloadSource: undefined },
        { source: undefined, payloadSource: source },
        { source, payloadSource: other },
      ]) {
        const item = toInboxItem({
          id: "item-1",
          loopId: "loop-1",
          dedupeKey: "conversation-1",
          state: "held",
          source: fields.source,
          sourcePayload: {
            source: fields.payloadSource,
            title: "Project update",
            from: "Sam",
            snippet: "Can you send the update?",
            ...(source === "gmail"
              ? { gmail: { threadId: "thread-1", subject: "Project update", to: ["sam@example.com"] } }
              : { slack: { channelId: "C1", ts: "1.2" } }),
          },
          proposal: { data: { body: "I will send it today." }, at: 1000, by: "agent" },
          sourceAt: 2000,
          updatedAt: 3000,
          thread: [],
        });
        assert.equal(item.source, source);
        inboxState.items = [item];
        inboxState.loaded = true;
        assert.deepEqual(itemsFor(source, "open"), [item]);
        assert.deepEqual(itemsFor(other, "open"), []);
        assert.equal(inboxOpenCount(source), 1);
        assert.equal(inboxOpenCount(other), 0);
        render(draftEditorTpl(item, { chat: false }), host);
        assert.equal(Boolean(host.querySelector(".inbox-draft.email")), source === "gmail");
        assert.equal(Boolean(host.querySelector(".inbox-draft.slack")), source === "slack");
        assert.equal(host.querySelector("textarea")?.getAttribute("rows"), source === "gmail" ? "7" : "3");
        if (source === "gmail") {
          assert.match(host.textContent ?? "", /To/);
          assert.match(host.textContent ?? "", /Subject/);
        }
      }
    }
  } finally {
    await vite.close();
    dom.window.close();
  }
});
