import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { createServer } from "vite";
import { inboxRuntime, until } from "./inbox-composer-fixture.ts";

test("a failed inbox followup preserves edits made while the request was pending", async () => {
  const domErrors: Error[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => domErrors.push(error));
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/",
    virtualConsole,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  for (const key of [
    "window",
    "document",
    "location",
    "history",
    "localStorage",
    "navigator",
    "HTMLElement",
    "Node",
    "CustomEvent",
    "Event",
    "customElements",
  ])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "window" ? dom.window : dom.window[key as keyof typeof dom.window],
    });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: dom.window.getComputedStyle.bind(dom.window),
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (fn: FrameRequestCallback) => setTimeout(() => fn(Date.now()), 0),
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: clearTimeout });
  const originalFetch = globalThis.fetch;
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    appState.me = { user: "taylor@example.com" };
    const { chatTpl, toInboxItem } = await vite.ssrLoadModule("/src/inbox.ts");
    const { render } = await vite.ssrLoadModule("lit");
    const host = dom.window.document.getElementById("main")!;
    for (const edited of [undefined, "New instruction", ""]) {
      const item = toInboxItem({
        id: `item-${String(edited)}`,
        loopId: "loop-1",
        state: "held",
        source: "slack",
        sourcePayload: { title: "Conversation", from: "Sam", snippet: "Please send the update" },
        thread: [],
      });
      let rejectRequest!: (error: Error) => void;
      globalThis.fetch = (url) =>
        String(url).includes("runtime-config")
          ? Promise.resolve(Response.json(inboxRuntime))
          : new Promise<Response>((_, reject) => {
              rejectRequest = reject;
            });
      render(chatTpl(item), host);
      await until(() => Boolean(host.querySelector(".composer-input:not(:disabled)")));
      let box = host.querySelector<HTMLTextAreaElement>(".composer-input")!;
      box.value = "Original instruction";
      box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      host.querySelector<HTMLButtonElement>(".send-btn")!.click();
      await until(() => Boolean(rejectRequest));
      box = host.querySelector<HTMLTextAreaElement>(".composer-input")!;
      assert.equal(box.disabled, false);
      if (edited !== undefined) {
        box.value = edited;
        box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      }
      rejectRequest(new Error("Request failed"));
      await until(() => Boolean(host.querySelector(".composer-error")));
      render(chatTpl(item), host);
      assert.equal(
        host.querySelector<HTMLTextAreaElement>(".composer-input")!.value,
        edited ? `Original instruction\n${edited}` : "Original instruction",
      );
    }
    assert.deepEqual(domErrors, []);
  } finally {
    const { render } = await vite.ssrLoadModule("lit");
    render(null, dom.window.document.getElementById("main")!);
    globalThis.fetch = originalFetch;
    await vite.close();
    dom.window.close();
  }
});
