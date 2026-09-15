import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

interface Control {
  identity: string;
  signedIn: boolean;
  overview: Promise<void> | null;
  imported: number;
  importBlock: Promise<void> | null;
  opened: string[];
  rendered: number;
  blockMemory: boolean;
  memoryByIdentity: Record<string, string>;
  memoryLoads: string[];
  memoryRequests: Array<{ identity: string; release(): void }>;
}

interface Harness {
  boot(): Promise<void>;
  close(): Promise<void>;
  control: Control;
  document: Document;
  loadAttempts(): number;
  shell: {
    appState: { currentView: string; me: { user: string } | null };
    switchView(view: string): void;
  };
  core: { api(path: string): Promise<unknown> };
  window: Window;
}

const runtimeConfig = {
  scopeId: "personal:tester",
  approvedHarnesses: [],
  modelsByHarness: {},
  modelCatalog: {},
  orgDefault: { harnessId: "pi", modelId: "m", revision: 1 },
  scopeOverride: null,
  effective: { harnessId: "pi", modelId: "m" },
  upgradeAvailable: false,
};

async function harness(path: string, virtualCron: "none" | "block" | "fail" = "none"): Promise<Harness> {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: `http://localhost${path}` });
  const control: Control = {
    identity: "user-a",
    signedIn: true,
    overview: null,
    imported: 0,
    importBlock: null,
    opened: [],
    rendered: 0,
    blockMemory: false,
    memoryByIdentity: { "user-a": "Memory A", "user-b": "Memory B" },
    memoryLoads: [],
    memoryRequests: [],
  };
  let moduleLoadAttempts = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const respond = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === "/signin" && init?.method === "POST") {
      control.signedIn = true;
      return Response.json({ ok: true });
    }
    if (url === "/force-401" || (url === "/me" && !control.signedIn)) {
      return Response.json({ mode: "dev", reason: "unauthenticated" }, { status: 401 });
    }
    if (url === "/me") {
      return Response.json({ user: control.identity, org: "test", mode: "dev", permissions: ["loops", "inbox"] });
    }
    if (url.startsWith("/api/runtime-config")) {
      return Response.json({ ...runtimeConfig, scopeId: `personal:${control.identity}` });
    }
    if (url.startsWith("/api/ui-state")) return Response.json({ value: null, updatedAt: 0 });
    if (url === "/api/sessions") return Response.json({ sessions: [] });
    if (url.startsWith("/api/inbox")) return Response.json({ items: [] });
    if (url === "/api/contexts") return Response.json({ contexts: [] });
    if (url === "/api/crons") return Response.json({ crons: [], visible: [] });
    if (url === "/api/webhooks") return Response.json({ webhooks: [] });
    if (url === "/api/loops") return Response.json({ loops: [] });
    if (url.startsWith("/api/files")) return Response.json({ owned: [], shared: [] });
    if (url === "/api/connectors") return Response.json({ providers: {} });
    if (url === "/api/keychain/overview") {
      if (control.overview) await control.overview;
      return Response.json({
        credentials: [{ id: control.identity, kind: "env", service: `${control.identity}-credential` }],
        connectorCredentials: [],
        grants: [],
        asks: [],
        scopeNames: {},
      });
    }
    if (url === "/api/deployments") return Response.json({ deployments: [] });
    if (url === "/api/memory") {
      const identity = control.identity;
      control.memoryLoads.push(identity);
      if (control.blockMemory) await new Promise<void>((release) => control.memoryRequests.push({ identity, release }));
      return Response.json({ content: control.memoryByIdentity[identity] ?? "", revision: "1" });
    }
    if (url.startsWith("/api/skills")) return Response.json({ skills: [] });
    return Response.json({});
  };
  const globals = {
    fetch: respond,
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    PointerEvent: dom.window.PointerEvent,
    MouseEvent: dom.window.MouseEvent,
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    cancelAnimationFrame: clearTimeout,
    EventSource: undefined,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    setTimeout: ((...args: Parameters<typeof setTimeout>) => {
      const id = realSetTimeout(...args);
      timers.add(id);
      return id;
    }) as typeof setTimeout,
    setInterval: ((...args: Parameters<typeof setInterval>) => {
      const id = realSetInterval(...args);
      timers.add(id);
      return id;
    }) as typeof setInterval,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = realSetTimeout(() => callback(Date.now()), 0);
      timers.add(id);
      return id as unknown as number;
    },
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  const shell = await vite.ssrLoadModule("/src/shell.ts");
  const core = await vite.ssrLoadModule("/src/core-bridge.ts");
  if (virtualCron !== "none") {
    const { lazyModule } = await vite.ssrLoadModule("/src/lazy-module.ts");
    shell.deferredViewLoaders.crons = lazyModule(async () => {
      moduleLoadAttempts++;
      if (virtualCron === "fail" && moduleLoadAttempts === 1) throw new Error("chunk unavailable");
      control.imported++;
      if (control.importBlock) await control.importBlock;
      return {
        resetView() {},
        open(id: string) {
          control.opened.push(id);
        },
        route(id: string | null) {
          control.opened.push(id ?? "index");
        },
        render() {
          control.rendered++;
          const heading = document.createElement("h1");
          heading.textContent = "Virtual crons";
          document.querySelector("#main")?.replaceChildren(heading);
        },
      };
    });
  }
  return {
    boot: shell.boot,
    close: async () => {
      await vite.close();
      dom.window.close();
      for (const id of timers) clearTimeout(id);
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
    control,
    document: dom.window.document,
    loadAttempts: () => moduleLoadAttempts,
    shell: shell as unknown as Harness["shell"],
    core: core as unknown as Harness["core"],
    window: dom.window as unknown as Window,
  };
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition did not settle");
}

test("every deferred route and legacy alias renders through the real DOM", async () => {
  const h = await harness("/webhooks");
  try {
    const routes = [
      ["/webhooks", "webhooks", "Webhooks"],
      ["/crons", "crons", "Crons"],
      ["/loops", "loops", "Loops"],
      ["/files", "files", "Files"],
      ["/connectors", "keychain", "Keychain"],
      ["/deploys", "deploys", "Apps"],
      ["/memory", "memory", "Memory"],
      ["/skills", "skills", "Skills"],
      ["/crons/missing", "crons", "wasn't found"],
      ["/webhooks/missing", "webhooks", "wasn't found"],
      ["/skills/missing", "skills", "wasn't found"],
      ["/?view=connectors", "keychain", "Keychain"],
      ["/?view=webhooks", "webhooks", "Webhooks"],
    ] as const;
    for (const [path, view, heading] of routes) {
      h.window.history.replaceState(null, "", path);
      await h.boot();
      assert.equal(h.shell.appState.currentView, view);
      assert.match(h.document.querySelector("#main")?.textContent ?? "", new RegExp(heading, "i"));
      assert.equal(h.document.querySelector('[role="alert"]'), null);
    }
  } finally {
    await h.close();
  }
});

test("a cold deep-link import cannot replace a newer navigation", async () => {
  const h = await harness("/crons/cron-a", "block");
  let release!: () => void;
  h.control.importBlock = new Promise<void>((resolve) => (release = resolve));
  try {
    const booted = h.boot();
    await eventually(() => h.control.imported === 1);
    h.shell.switchView("settings");
    release();
    await booted;
    assert.equal(h.shell.appState.currentView, "settings");
    assert.match(h.document.querySelector("#main")?.textContent ?? "", /Settings/i);
    assert.deepEqual(h.control.opened, []);
    assert.equal(h.control.rendered, 0);
  } finally {
    release();
    await h.close();
  }
});

test("a failed deferred chunk shows a retry action and recovers", async () => {
  const h = await harness("/crons/cron-a", "fail");
  try {
    await h.boot();
    const alert = h.document.querySelector('[role="alert"]');
    assert.match(alert?.textContent ?? "", /couldn't load crons/i);
    const retry = alert?.querySelector<HTMLButtonElement>("button");
    assert.ok(retry);
    retry.click();
    await eventually(() => h.document.querySelector("#main")?.textContent === "Virtual crons");
    assert.equal(h.loadAttempts(), 2);
    assert.deepEqual(h.control.opened, ["cron-a"]);
  } finally {
    await h.close();
  }
});

test("a 401 then dev sign-in clears loaded identity-bound keychain data", async () => {
  const h = await harness("/keychain");
  let releaseOverview!: () => void;
  try {
    await h.boot();
    assert.match(h.document.querySelector("#main")?.textContent ?? "", /user-a-credential/);
    h.control.signedIn = false;
    await assert.rejects(h.core.api("/force-401"));
    assert.match(h.document.querySelector("#app")?.textContent ?? "", /Dev sign-in/);

    h.control.identity = "user-b";
    h.control.overview = new Promise<void>((resolve) => (releaseOverview = resolve));
    const input = h.document.querySelector<HTMLInputElement>("#dev-principal")!;
    input.value = "user-b";
    input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await eventually(() => /Loading credentials/.test(h.document.querySelector("#main")?.textContent ?? ""));
    assert.doesNotMatch(h.document.querySelector("#main")?.textContent ?? "", /user-a-credential/);
    assert.equal(h.shell.appState.me?.user, "user-b");
    releaseOverview();
    h.control.overview = null;
    await eventually(() => /user-b-credential/.test(h.document.querySelector("#main")?.textContent ?? ""));
  } finally {
    releaseOverview?.();
    await h.close();
  }
});

function editMemory(document: Document, value: string): void {
  const editor = document.querySelector<HTMLTextAreaElement>(".memory-text");
  assert.ok(editor);
  editor.value = value;
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function submitDevSignin(document: Document, identity: string): void {
  const input = document.querySelector<HTMLInputElement>("#dev-principal");
  assert.ok(input?.form);
  input.value = identity;
  input.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

test("same-user reauthentication preserves an unsaved memory draft", async () => {
  const h = await harness("/memory");
  try {
    await h.boot();
    editMemory(h.document, "Unsaved A draft");
    assert.match(h.document.querySelector("#main")?.textContent ?? "", /Unsaved changes/);

    h.control.signedIn = false;
    await assert.rejects(h.core.api("/force-401"));
    assert.match(h.document.querySelector("#app")?.textContent ?? "", /Dev sign-in/);

    submitDevSignin(h.document, "user-a");
    await eventually(
      () =>
        h.shell.appState.me?.user === "user-a" &&
        h.document.querySelector<HTMLTextAreaElement>(".memory-text")?.value === "Unsaved A draft",
    );
    assert.deepEqual(h.control.memoryLoads, ["user-a"]);
    assert.match(h.document.querySelector("#main")?.textContent ?? "", /Unsaved changes/);
  } finally {
    await h.close();
  }
});

test("a different principal cannot inherit the prior user's unsaved memory draft", async () => {
  const h = await harness("/memory");
  try {
    await h.boot();
    editMemory(h.document, "Private draft for A");

    h.control.signedIn = false;
    await assert.rejects(h.core.api("/force-401"));
    h.control.identity = "user-b";
    h.control.blockMemory = true;
    submitDevSignin(h.document, "user-b");

    await eventually(() => h.control.memoryRequests.some((request) => request.identity === "user-b"));
    assert.doesNotMatch(h.document.querySelector("#app")?.textContent ?? "", /Private draft for A/);
    h.control.memoryRequests.find((request) => request.identity === "user-b")!.release();
    await eventually(
      () =>
        h.shell.appState.me?.user === "user-b" &&
        h.document.querySelector<HTMLTextAreaElement>(".memory-text")?.value === "Memory B",
    );
    assert.deepEqual(h.control.memoryLoads, ["user-a", "user-b"]);
  } finally {
    for (const request of h.control.memoryRequests) request.release();
    await h.close();
  }
});

test("a pending memory load from the prior principal cannot replace the new principal's memory", async () => {
  const h = await harness("/memory");
  h.control.blockMemory = true;
  try {
    const firstBoot = h.boot();
    await eventually(() => h.control.memoryRequests.some((request) => request.identity === "user-a"));

    h.control.signedIn = false;
    await assert.rejects(h.core.api("/force-401"));
    h.control.identity = "user-b";
    submitDevSignin(h.document, "user-b");
    await eventually(() => h.control.memoryRequests.some((request) => request.identity === "user-b"));

    h.control.memoryRequests.find((request) => request.identity === "user-b")!.release();
    await eventually(() => h.document.querySelector<HTMLTextAreaElement>(".memory-text")?.value === "Memory B");
    h.control.memoryRequests.find((request) => request.identity === "user-a")!.release();
    await firstBoot;
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(h.document.querySelector<HTMLTextAreaElement>(".memory-text")?.value, "Memory B");
    assert.equal(h.shell.appState.me?.user, "user-b");
  } finally {
    for (const request of h.control.memoryRequests) request.release();
    await h.close();
  }
});
