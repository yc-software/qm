import { JSDOM, type ConstructorOptions } from "jsdom";
import { createServer, type PluginOption, type ViteDevServer } from "vite";

export interface BrowserEnv {
  dom: JSDOM;
  vite: ViteDevServer;
  close: () => Promise<void>;
}

export async function browserEnv(
  options: {
    dom?: ConstructorOptions;
    html?: string;
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    plugins?: PluginOption[];
  } = {},
): Promise<BrowserEnv> {
  const dom = new JSDOM(options.html ?? '<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
    ...options.dom,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  dom.window.HTMLElement.prototype.getAnimations = () => [];
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const track = <T extends ReturnType<typeof setTimeout>>(id: T): T => (timers.add(id), id);
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    InputEvent: dom.window.InputEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.PointerEvent,
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    EventSource: undefined,
    fetch: options.fetch ?? globalThis.fetch,
    setTimeout: ((...args: Parameters<typeof setTimeout>) => track(realSetTimeout(...args))) as typeof setTimeout,
    setInterval: ((...args: Parameters<typeof setInterval>) => track(realSetInterval(...args))) as typeof setInterval,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      track(realSetTimeout(() => callback(Date.now()), 0)) as unknown as number,
    cancelAnimationFrame: clearTimeout,
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const restore = () => {
    for (const id of timers) clearTimeout(id);
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  };
  let vite: ViteDevServer;
  try {
    vite = await createServer({
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: "custom",
      plugins: options.plugins,
    });
  } catch (error) {
    restore();
    throw error;
  }
  return {
    dom,
    vite,
    close: async () => {
      try {
        await vite.close();
      } finally {
        restore();
      }
    },
  };
}
