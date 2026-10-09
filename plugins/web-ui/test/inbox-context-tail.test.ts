import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("long Slack conversations show the latest messages and reveal earlier ones on request", async () => {
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
    const { contextTpl, toInboxItem, CONTEXT_TAIL } = await vite.ssrLoadModule("/src/inbox.ts");
    const { render } = await vite.ssrLoadModule("lit");
    const host = dom.window.document.getElementById("main")!;
    const texts = (): string[] => [...host.querySelectorAll(".inbox-context-text")].map((el) => el.textContent!.trim());
    const item = (id: string, count: number) =>
      toInboxItem({
        id,
        loopId: "loop-1",
        dedupeKey: id,
        state: "held",
        source: "slack",
        sourcePayload: {
          source: "slack",
          title: "Conversation",
          from: "Sam",
          snippet: "latest",
          sourceContextFetched: true,
          context: Array.from({ length: count }, (_, i) => ({ author: "Alex", at: 1000 + i, text: `m${i}` })),
        },
        sourceAt: 2000,
        updatedAt: 3000,
        thread: [],
      });

    const short = item("short", CONTEXT_TAIL);
    render(contextTpl(short), host);
    assert.equal(texts().length, CONTEXT_TAIL);
    assert.equal(host.querySelector(".inbox-earlier"), null);

    const long = item("long", 60);
    render(contextTpl(long), host);
    assert.deepEqual(
      texts(),
      Array.from({ length: CONTEXT_TAIL }, (_, i) => `m${60 - CONTEXT_TAIL + i}`),
    );
    const earlier = host.querySelector<HTMLButtonElement>(".inbox-earlier")!;
    assert.equal(earlier.textContent!.trim(), `${60 - CONTEXT_TAIL} earlier messages`);
    earlier.click();
    render(contextTpl(long), host);
    assert.equal(texts().length, CONTEXT_TAIL + 20);
    assert.equal(texts().at(-1), "m59");
    host.querySelector<HTMLButtonElement>(".inbox-earlier")!.click();
    host.querySelector<HTMLButtonElement>(".inbox-earlier")?.click();
    render(contextTpl(long), host);
    assert.equal(texts().length, 60);
    assert.equal(texts()[0], "m0");
    assert.equal(host.querySelector(".inbox-earlier"), null);
  } finally {
    await vite.close();
  }
});
