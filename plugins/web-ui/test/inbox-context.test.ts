import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("conversation details include the waiting message after prior context with correctly routed attachments", async () => {
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
    const { contextTpl, toInboxItem } = await vite.ssrLoadModule("/src/inbox.ts");
    const { render } = await vite.ssrLoadModule("lit");
    const host = dom.window.document.getElementById("main")!;
    for (const source of ["slack", "gmail"]) {
      for (const context of [
        undefined,
        [],
        [{ author: "Alex", at: 1000, text: "Earlier message", images: ["https://example.com/old.png"] }],
      ]) {
        const item = toInboxItem({
          id: "item-1",
          loopId: "loop-1",
          dedupeKey: "conversation-1",
          state: "held",
          source,
          sourcePayload: {
            title: "Conversation",
            from: "Sam",
            snippet: "Latest waiting message",
            context,
            images: ["https://example.com/latest.png"],
          },
          sourceAt: 2000,
          updatedAt: 3000,
          thread: [],
        });
        render(contextTpl(item), host);
        assert.deepEqual(
          [...host.querySelectorAll(".inbox-context-text")].map((el) => el.textContent?.trim()),
          context?.length ? ["Earlier message", "Latest waiting message"] : ["Latest waiting message"],
        );
        const messages = host.querySelectorAll(".inbox-context-msg");
        const latest = messages[messages.length - 1]!;
        assert.equal(latest.querySelector(".inbox-context-author")?.textContent, "Sam");
        assert.ok(latest.querySelector(".inbox-context-at"));
        assert.equal(
          latest.querySelector("img")?.getAttribute("src"),
          "/api/loops/loop-1/items/item-1/image?ctx=-1&i=0",
        );
        if (context?.length)
          assert.equal(
            messages[0]!.querySelector("img")?.getAttribute("src"),
            "/api/loops/loop-1/items/item-1/image?ctx=0&i=0",
          );
        assert.equal(item.context, context);
      }
    }
  } finally {
    await vite.close();
    dom.window.close();
  }
});
