import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { createServer } from "vite";

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
  for (const key of ["window", "document", "location", "history", "localStorage", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "window" ? dom.window : dom.window[key as keyof typeof dom.window],
    });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: dom.window.getComputedStyle.bind(dom.window),
  });
  const originalFetch = globalThis.fetch;
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { askAgent, chatTpl, toInboxItem, resetInboxState } = await vite.ssrLoadModule("/src/inbox.ts");
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
      globalThis.fetch = () =>
        new Promise<Response>((_, reject) => {
          rejectRequest = reject;
        });
      const request = askAgent(item, "Original instruction");
      render(chatTpl(item), host);
      const box = host.querySelector<HTMLTextAreaElement>(".inbox-chat-input")!;
      assert.equal(box.disabled, false);
      assert.equal(host.querySelectorAll(".inbox-chat-msg.human").length, 1);
      assert.equal(host.querySelector(".inbox-chat-header-title")?.textContent, "Original instruction");
      item.thread.push({ id: "persisted", role: "human", text: "Original instruction", at: Date.now() });
      render(chatTpl(item), host);
      assert.equal(host.querySelectorAll(".inbox-chat-msg.human").length, 1);
      if (edited !== undefined) {
        box.value = edited;
        box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      }
      rejectRequest(new Error("Request failed"));
      await request;
      render(chatTpl(item), host);
      assert.equal(
        host.querySelector<HTMLTextAreaElement>(".inbox-chat-input")!.value,
        edited ?? "Original instruction",
      );
    }
    const item = toInboxItem({
      id: "saved-input",
      loopId: "loop-1",
      state: "held",
      source: "gmail",
      sourcePayload: { title: "Reply", from: "Alex", snippet: "Please reply" },
      thread: [],
    });
    render(chatTpl(item), host);
    const box = host.querySelector<HTMLTextAreaElement>(".inbox-chat-input")!;
    box.value = "Please keep this instruction";
    box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const { flushDrafts } = await vite.ssrLoadModule("/src/drafts.ts");
    flushDrafts();
    resetInboxState();
    render(chatTpl(item), host);
    assert.equal(host.querySelector<HTMLTextAreaElement>(".inbox-chat-input")!.value, "Please keep this instruction");
    render(chatTpl({ ...item, conversationId: "new" }), host);
    assert.equal(host.querySelector<HTMLTextAreaElement>(".inbox-chat-input")!.value, "");
    assert.equal(host.querySelector(".inbox-chat-header-title")?.textContent, "");
    assert.deepEqual(domErrors, []);
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
    dom.window.close();
  }
});
