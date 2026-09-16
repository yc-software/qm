import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
}

test("the share dialog offers only permitted audiences and shows the server's policy rejection", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new dom.window.Event("close"));
  };
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    EventSource: undefined,
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  let audiences = ["internal"];
  const posted: string[] = [];
  const rejection =
    "Links for anyone are turned off by policy for this conversation. Share with your organization instead.";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (!path.endsWith("/api/sessions/s1/share")) throw new Error(`Unexpected request: ${path}`);
    if ((init?.method ?? "GET") === "GET") return Response.json({ audiences });
    const body = JSON.parse(String(init?.body)) as { audience: string };
    posted.push(body.audience);
    if (body.audience === "external")
      return Response.json({ error: "external_sharing_prohibited", message: rejection }, { status: 403 });
    return Response.json({ share: { token: "t1", audience: body.audience, createdAt: 1 } });
  };
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  try {
    const { openSessionShare } = await vite.ssrLoadModule("/src/session-share.ts");
    const dialog = () => document.querySelector<HTMLDialogElement>("dialog.session-share-dialog")!;
    const options = () => [...dialog().querySelectorAll<HTMLButtonElement>(".menu-option")];

    await openSessionShare("s1");
    await until(() => !!dialog().querySelector(".share-policy-note"));
    assert.deepEqual(
      options().map((option) => option.textContent!.trim()),
      ["Anyone in your organization"],
    );
    assert.equal(dialog().querySelector<HTMLButtonElement>(".share-audience-button")!.disabled, true);
    assert.match(dialog().querySelector(".share-policy-note")!.textContent!, /turned off by policy/);
    dialog().querySelector<HTMLButtonElement>(".project-dialog-actions button")!.click();
    await until(() => !!dialog().querySelector(".share-link-row input"));
    assert.deepEqual(posted, ["internal"]);
    dialog().querySelector<HTMLButtonElement>(".chip-x")!.click();
    await until(() => !document.querySelector("dialog.session-share-dialog"));

    audiences = ["internal", "external"];
    await openSessionShare("s1");
    await until(() => options().length === 2);
    assert.equal(dialog().querySelector(".share-policy-note"), null);
    assert.equal(dialog().querySelector<HTMLButtonElement>(".share-audience-button")!.disabled, false);
    options()[1]!.click();
    await until(() => !!dialog().querySelector(".share-external-warning"));
    dialog().querySelector<HTMLButtonElement>(".project-dialog-actions button")!.click();
    await until(() => !!dialog().querySelector(".composer-error"));
    assert.equal(dialog().querySelector(".composer-error")!.textContent!.trim(), rejection);
    assert.equal(dialog().querySelector(".share-link-row"), null);
    assert.deepEqual(posted, ["internal", "external"]);
  } finally {
    await vite.close();
    globalThis.fetch = originalFetch;
  }
});
