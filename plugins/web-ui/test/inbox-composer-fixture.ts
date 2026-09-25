import { JSDOM, type ConstructorOptions } from "jsdom";
import { createServer, type PluginOption } from "vite";
import { metadata } from "./model-metadata.ts";
export const inboxRuntime = {
  scopeId: "personal:taylor@example.com",
  modelCatalog: {
    "gpt-5.6-sol": metadata("gpt-5.6-sol", "GPT-5.6 Sol"),
    "gpt-5.6-terra": metadata("gpt-5.6-terra", "GPT-5.6 Terra"),
  },
  approvedHarnesses: ["pi"],
  modelsByHarness: { pi: ["gpt-5.6-sol", "gpt-5.6-terra"] },
  orgDefault: { harnessId: "pi", modelId: "gpt-5.6-sol", revision: 0 },
  effective: { harnessId: "pi", modelId: "gpt-5.6-sol", effortLevel: "medium", fastMode: false },
  fastModeModelIds: ["gpt-5.6-sol", "gpt-5.6-terra"],
  scopeOverride: null,
};

export async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("composer did not settle");
}

export async function createInboxFixture(options: { dom?: ConstructorOptions; plugins?: PluginOption[] } = {}) {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/",
    ...options.dom,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  const close = async () => {
    try {
      if (vite) {
        try {
          const { render } = await vite.ssrLoadModule("lit");
          render(null, dom.window.document.getElementById("main")!);
        } finally {
          await vite.close();
        }
      }
    } finally {
      dom.window.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
  try {
    for (const key of [
      "window",
      "document",
      "location",
      "history",
      "localStorage",
      "navigator",
      "Element",
      "HTMLElement",
      "Node",
      "CustomEvent",
      "Event",
      "customElements",
    ])
      setGlobal(key, key === "window" ? dom.window : dom.window[key as keyof typeof dom.window]);
    setGlobal("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
    setGlobal(
      "requestAnimationFrame",
      options.dom?.pretendToBeVisual
        ? dom.window.requestAnimationFrame.bind(dom.window)
        : (fn: FrameRequestCallback) => setTimeout(() => fn(Date.now()), 0),
    );
    setGlobal(
      "cancelAnimationFrame",
      options.dom?.pretendToBeVisual ? dom.window.cancelAnimationFrame.bind(dom.window) : clearTimeout,
    );
    setGlobal("fetch", globalThis.fetch);
    vite = await createServer({
      server: { middlewareMode: true, hmr: false },
      appType: "custom",
      plugins: options.plugins,
    });
    return { dom, vite, host: dom.window.document.getElementById("main")!, close };
  } catch (error) {
    await close();
    throw error;
  }
}
