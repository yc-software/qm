import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("successful ambient-policy saves show a completed status in English and Japanese", async () => {
  const dom = new JSDOM('<!doctype html><meta name="qm-locale" content="en"><div id="root"></div>', {
    url: "http://localhost/web-ui/contexts",
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    customElements: dom.window.customElements,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  try {
    const policy = await vite.ssrLoadModule("/src/ambient-policy.ts");
    const { render } = await vite.ssrLoadModule("lit");
    const root = document.querySelector<HTMLElement>("#root")!;
    const expected = { en: "Saved.", ja: "保存しました。" } as const;
    for (const selected of ["en", "ja"] as const) {
      document.querySelector<HTMLMetaElement>('meta[name="qm-locale"]')!.content = selected;
      policy.resetAmbientPolicy();
      let saved!: () => void;
      const savedRequest = new Promise<void>((resolve) => {
        saved = resolve;
      });
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: async (_input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === "PUT") saved();
          return Response.json({
            policy: { orders: "Watch releases", bots: {}, ambientEnabled: true, updatedAt: 2 },
          });
        },
      });
      const scope = `group:${selected}`;
      const redraw = () => render(policy.ambientPolicySection(scope), root);
      await policy.loadAmbientPolicy(scope, redraw);
      policy.ambientPolicyState.dirty = true;
      redraw();
      root.querySelector<HTMLButtonElement>(".ambient-policy-actions .btn.primary")!.click();
      await savedRequest;
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(root.querySelector<HTMLElement>('[aria-live="polite"]')?.textContent?.trim(), expected[selected]);
    }
  } finally {
    await vite.close();
    if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor);
    else delete (globalThis as { fetch?: typeof fetch }).fetch;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  }
});

test("failed uploads preserve HTTP status fallbacks and server error text", async () => {
  const dom = new JSDOM('<!doctype html><meta name="qm-locale" content="en"><div id="app"></div>', {
    url: "http://localhost/web-ui/files",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLDialogElement: dom.window.HTMLDialogElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    SubmitEvent: dom.window.SubmitEvent,
    InputEvent: dom.window.InputEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  try {
    const files = await vite.ssrLoadModule("/src/files.ts");
    const uploadFailureMessage = files.uploadFailureMessage as
      | ((response: Response) => Promise<string>)
      | undefined;
    assert.equal(typeof uploadFailureMessage, "function");
    const cases = [
      { locale: "en", status: 401, body: "", want: "Upload failed (401)." },
      { locale: "ja", status: 413, body: "", want: "アップロードできませんでした（413）。" },
      { locale: "en", status: 500, body: "", want: "Upload failed (500)." },
      { locale: "en", status: 500, body: '{"message":"Quota exceeded"}', want: "Quota exceeded" },
      { locale: "ja", status: 413, body: '{"error":"Payload too large"}', want: "Payload too large" },
      { locale: "ja", status: 500, body: "upstream unavailable", want: "upstream unavailable" },
    ] as const;
    for (const row of cases) {
      document.querySelector<HTMLMetaElement>('meta[name="qm-locale"]')!.content = row.locale;
      assert.equal(
        await uploadFailureMessage!(new Response(row.body, { status: row.status })),
        row.want,
        `${row.locale} ${row.status}`,
      );
    }
  } finally {
    await vite.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  }
});
