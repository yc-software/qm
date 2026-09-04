import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { CoreContext } from "../src/core-bridge.ts";

test("project interactions preserve focus and successful local mutations", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/?view=contexts",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", {
    value(this: HTMLDialogElement) {
      this.open = true;
    },
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
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  let resolveContexts!: (response: Response) => void;
  const staleContexts = new Promise<Response>((resolve) => {
    resolveContexts = resolve;
  });
  let contextsRequested = false;
  let projectCreated!: () => void;
  const created = new Promise<void>((resolve) => {
    projectCreated = resolve;
  });
  const personal = {
    scopeId: "personal:owner",
    kind: "personal",
    name: "Personal",
    sessionCount: 0,
    lastActivityAt: null,
  } as const;
  const project = {
    id: "project-1",
    name: "Launch",
    ownerId: "owner",
    memberIds: ["owner"],
    scopeId: "project:1",
    members: [{ principalId: "owner", displayName: "Owner" }],
  };
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path === "/api/contexts") {
      if (!contextsRequested) {
        contextsRequested = true;
        return staleContexts;
      }
      return Response.json({ contexts: [personal] });
    }
    if (path === "/api/sessions") return Response.json({ sessions: [] });
    if (path === "/api/projects" && init?.method === "POST") {
      projectCreated();
      return Response.json({ project });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { contextsState, renderContexts } = await vite.ssrLoadModule("/src/contexts.ts");
    appState.me = { user: "owner", org: "acme" };
    appState.currentView = "contexts";
    appState.mainEl = document.querySelector("#main");
    contextsState.list = [];
    contextsState.loaded = false;
    contextsState.loadedAt = 0;

    const rendering = renderContexts();
    const opener = document.querySelector<HTMLButtonElement>(".project-create-button")!;
    opener.focus();
    opener.click();
    await Promise.resolve();
    document.querySelector<HTMLButtonElement>(".project-dialog-actions .btn")!.click();
    await Promise.resolve();
    const focusRestored = document.activeElement?.classList.contains("project-create-button") === true;

    document.querySelector<HTMLButtonElement>(".project-create-button")!.click();
    await Promise.resolve();
    document
      .querySelector<HTMLFormElement>(".project-dialog form")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    const emptyNameFocusRestored = document.activeElement?.id === "project-name";
    const input = document.querySelector<HTMLInputElement>("#project-name")!;
    input.value = project.name;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    document
      .querySelector<HTMLFormElement>(".project-dialog form")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await created;
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveContexts(Response.json({ contexts: [personal] }));
    await rendering;

    assert.deepEqual(
      {
        focusRestored,
        emptyNameFocusRestored,
        projectPreserved: contextsState.list.some((context: CoreContext) => context.scopeId === project.scopeId),
        personalPreserved: contextsState.list.some((context: CoreContext) => context.scopeId === personal.scopeId),
      },
      { focusRestored: true, emptyNameFocusRestored: true, projectPreserved: true, personalPreserved: true },
    );
  } finally {
    await vite.close();
  }
});
