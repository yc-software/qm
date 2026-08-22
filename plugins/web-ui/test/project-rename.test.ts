import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { CoreContext } from "../src/core-bridge.ts";

test("project detail rename is owner-only and skips personal", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/?view=contexts",
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
    KeyboardEvent: dom.window.KeyboardEvent,
    InputEvent: dom.window.InputEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const personal = {
    scopeId: "personal:owner",
    kind: "personal",
    name: "Personal",
    sessionCount: 0,
    lastActivityAt: null,
  } as const;
  const ownedProject = {
    id: "project-1",
    name: "Launch",
    ownerId: "owner",
    memberIds: ["owner", "pal"],
    scopeId: "project:1",
    members: [
      { principalId: "owner", displayName: "Owner" },
      { principalId: "pal", displayName: "Pal" },
    ],
  };
  const memberProject = {
    id: "project-2",
    name: "Shared",
    ownerId: "other",
    memberIds: ["other", "owner"],
    scopeId: "project:2",
    members: [
      { principalId: "other", displayName: "Other" },
      { principalId: "owner", displayName: "Owner" },
    ],
  };
  const ownedContext = {
    scopeId: ownedProject.scopeId,
    kind: "group",
    name: ownedProject.name,
    sessionCount: 0,
    lastActivityAt: null,
    project: ownedProject,
  } as CoreContext;
  const memberContext = {
    scopeId: memberProject.scopeId,
    kind: "group",
    name: memberProject.name,
    sessionCount: 0,
    lastActivityAt: null,
    project: memberProject,
  } as CoreContext;
  let patchedName: string | null = null;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path === "/api/contexts") {
      return Response.json({ contexts: [personal, ownedContext, memberContext] });
    }
    if (path === "/api/sessions") return Response.json({ sessions: [] });
    if (path.startsWith("/api/scope-resources?")) {
      return Response.json({ files: [], webhooks: [], crons: [], deployments: [], skills: [], manageable: true });
    }
    if (path.includes("/ambient-policy")) {
      return Response.json({ policy: { orders: "", bots: {}, updatedAt: 0 } });
    }
    if (path.startsWith("/api/channel-header-pin")) {
      return Response.json({ pin: null });
    }
    if (path.startsWith("/api/runtime-config")) {
      return Response.json({}, { status: 503 });
    }
    if (path === `/api/projects/${ownedProject.id}` && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as { name: string };
      patchedName = body.name;
      return Response.json({
        project: { ...ownedProject, name: body.name },
      });
    }
    if (method === "GET") return Response.json({});
    throw new Error(`Unexpected request: ${method} ${path}`);
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { contextsState, renderContexts, openProjectDetail } = await vite.ssrLoadModule("/src/contexts.ts");
    appState.me = { user: "owner", org: "acme" };
    appState.currentView = "contexts";
    appState.mainEl = document.querySelector("#main");
    contextsState.list = [];
    contextsState.loaded = false;
    contextsState.loadedAt = 0;

    await renderContexts();

    openProjectDetail(personal.scopeId);
    await Promise.resolve();
    assert.equal(document.querySelector(".context-rename-edit"), null);

    openProjectDetail(memberProject.scopeId);
    await Promise.resolve();
    assert.equal(document.querySelector(".context-rename-edit"), null);
    assert.match(document.querySelector(".pane-title")?.textContent ?? "", /Shared/);

    openProjectDetail(ownedProject.scopeId);
    await Promise.resolve();
    const renameButton = document.querySelector<HTMLButtonElement>(".context-rename-edit");
    assert.ok(renameButton);
    renameButton.click();
    await Promise.resolve();
    const input = document.querySelector<HTMLInputElement>(".context-rename-input");
    assert.ok(input);
    assert.equal(input.value, "Launch");
    contextsState.renameDraft = "Launch Renamed";
    input.value = "Launch Renamed";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    for (let i = 0; i < 40 && (patchedName === null || contextsState.renaming); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    assert.equal(patchedName, "Launch Renamed");
    assert.equal(
      contextsState.list.find((context: CoreContext) => context.scopeId === ownedProject.scopeId)?.project?.name,
      "Launch Renamed",
    );
    assert.equal(contextsState.renaming, false);
    assert.match(document.querySelector(".pane-title")?.textContent ?? "", /Launch Renamed/);
  } finally {
    await vite.close();
  }
});
