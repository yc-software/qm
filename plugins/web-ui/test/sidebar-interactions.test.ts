import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { SidebarLayout } from "../src/sidebar-model.ts";

test("sidebar organization survives reload, handles failed saves, and isolates identity changes", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main><div id="sidebar-body"></div>', {
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
    HTMLSelectElement: dom.window.HTMLSelectElement,
    Element: dom.window.Element,
    KeyboardEvent: dom.window.KeyboardEvent,
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

  let stored: unknown = null;
  let reads = 0;
  const keepaliveWrites: boolean[] = [];
  let savedAt = 0;
  let failWrites = false;
  let holdWrite: ((response: Response) => void) | null = null;
  let pauseWrites = false;
  const writes: SidebarLayout[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.startsWith("/api/ui-state")) {
      if (init?.method !== "PUT") {
        reads++;
        return Response.json({ value: stored, updatedAt: savedAt });
      }
      const body = JSON.parse(String(init.body)) as { value: SidebarLayout; updatedAt: number };
      writes.push(body.value);
      keepaliveWrites.push(init.keepalive === true);
      if (pauseWrites)
        return new Promise<Response>((resolve) => {
          holdWrite = resolve;
        });
      if (failWrites) return Response.json({ message: "Unavailable" }, { status: 503 });
      if (body.updatedAt < savedAt) return Response.json({ ok: false, updatedAt: savedAt });
      stored = body.value;
      savedAt = body.updatedAt;
      return Response.json({ ok: true, updatedAt: savedAt });
    }
    if (path === "/api/contexts") return Response.json({ contexts: [] });
    throw new Error(`Unexpected request: ${path}`);
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 15));
  const button = (label: string) => {
    const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
    );
    assert.ok(element, `Button ${label} exists`);
    return element;
  };
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { contextsState } = await vite.ssrLoadModule("/src/contexts.ts");
    const { renderList, sessionsState, clearSessionSelection } = await vite.ssrLoadModule("/src/sessions.ts");
    const { sidebarState, loadSidebarState, resetSidebarState, updateSidebarLayout, saveSidebarState } =
      await vite.ssrLoadModule("/src/sidebar-state.ts");
    const { toggleSidebarCustomization } = await vite.ssrLoadModule("/src/sidebar.ts");
    appState.me = { user: "owner", org: "acme" };
    appState.currentView = "contexts";
    appState.listEl = document.querySelector("#sidebar-body");
    contextsState.loaded = true;
    contextsState.loadedAt = Date.now();
    contextsState.list = ["Alpha", "Beta"].map((name) => ({
      scopeId: `group:${name}`,
      kind: "group",
      name,
      project: { id: name, name, ownerId: "owner", scopeId: `group:${name}` },
    }));
    sessionsState.list = Array.from({ length: 12 }, (_, index) => ({
      id: `s${index}`,
      threadRef: `web:owner:${index}`,
      scopeId: "personal:owner",
      title: `Chat ${index}`,
      type: "dm",
      createdAt: index + 1,
      pinned: index === 0,
    }));
    const firstLoad = loadSidebarState();
    assert.equal(loadSidebarState(), firstLoad, "concurrent retries join the same read");
    await firstLoad;
    assert.equal(reads, 1);
    renderList();
    assert.equal(document.querySelectorAll('[aria-label="Private"] [data-session-id]').length, 10);
    assert.equal(document.querySelectorAll('[aria-label="Favorites"] [data-session-id]').length, 1);
    button("Show 2 more").click();
    assert.equal(document.querySelectorAll('[aria-label="Private"] [data-session-id]').length, 12);
    button("Options for Alpha").click();
    button("Add to favorites").click();
    await settle();
    assert.equal(
      document.querySelector('[aria-label="Favorites"] [data-project-scope]')?.getAttribute("data-project-scope"),
      "group:Alpha",
    );
    assert.equal(document.querySelectorAll('[data-project-scope="group:Alpha"]').length, 2);

    toggleSidebarCustomization();
    const input = document.querySelector<HTMLInputElement>('input[aria-label="New section name"]')!;
    input.value = "Product";
    input.closest("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await settle();
    button("Move Product up").click();
    await settle();
    toggleSidebarCustomization();
    button("Options for Beta").click();
    const product = sidebarState.layout.sections.find((section: { name: string }) => section.name === "Product");
    const moveBeta = document.querySelector<HTMLSelectElement>('select[aria-label="Move Beta to section"]')!;
    moveBeta.value = product.id;
    moveBeta.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    button("Product").click();
    await settle();
    assert.equal(document.querySelector('[aria-label="Product"] button')?.getAttribute("aria-expanded"), "false");
    const saved = structuredClone(stored);
    resetSidebarState();
    await loadSidebarState();
    assert.deepEqual(sidebarState.layout, saved);
    assert.equal(
      document.querySelector('[aria-label="Product"] [data-project-scope]')?.getAttribute("data-project-scope"),
      "group:Beta",
    );

    toggleSidebarCustomization();
    button("Remove Product section").click();
    await settle();
    toggleSidebarCustomization();
    assert.ok(document.querySelector('[aria-label="Projects"] [data-project-scope="group:Beta"]'));

    const setValue = (label: string, value: string) => {
      const element = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
      assert.ok(element, label);
      element.value = value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const submit = (label: string, value: string) => {
      const element = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      element.value = value;
      element.closest("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    };
    button("Favorites").click();
    document
      .querySelector<HTMLButtonElement>('[aria-label="Projects"] button[aria-label="Options for Alpha"]')!
      .click();
    button("Rename").click();
    await settle();
    assert.equal(document.querySelectorAll(".session-rename-input").length, 1);
    assert.ok(document.activeElement?.closest('[aria-label="Projects"]'));
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const privateChat = document.querySelector<HTMLElement>('[aria-label="Private"] [data-session-id="s1"] .session')!;
    privateChat.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(document.querySelectorAll(".session-rename-input").length, 1);
    assert.ok(document.activeElement?.closest('[aria-label="Private"]'));
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document
      .querySelector<HTMLElement>('[aria-label="Private"] [data-session-id="s2"] .session')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    document
      .querySelector<HTMLElement>('[aria-label="Private"] [data-session-id="s0"] .session')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
    assert.equal(document.querySelectorAll('[aria-label="Private"] .session-row.selected').length, 3);
    clearSessionSelection();

    const previousSessions = sessionsState.list;
    sessionsState.list = [
      ...["a", "b", "c"].map((id, index) => ({
        id: `project-${id}`,
        threadRef: `web:owner:project-${id}`,
        scopeId: "group:Alpha",
        title: `Project ${id}`,
        type: "dm",
        createdAt: 10 - index,
        pinned: id === "b",
      })),
      {
        id: "standalone",
        threadRef: "web:owner:standalone",
        scopeId: "personal:owner",
        title: "Standalone",
        type: "dm",
        createdAt: 1,
        pinned: true,
      },
    ];
    button("Favorites").click();
    renderList();
    const standaloneFavorite = (id: string) =>
      document.querySelector<HTMLElement>(
        `[aria-label="Favorites"] [data-sidebar-location="favorites"][data-session-id="${id}"] .session`,
      )!;
    standaloneFavorite("project-b").dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }),
    );
    standaloneFavorite("standalone").dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }),
    );
    assert.equal(
      document.querySelectorAll('[data-session-id="project-c"].selected').length,
      0,
      "range selection uses the clicked occurrence's group",
    );
    assert.ok(document.querySelector('[data-session-id="standalone"].selected'));
    clearSessionSelection();
    sessionsState.list = previousSessions;
    renderList();
    button("Options for Private section").click();
    setValue("Show items in Private", "5");
    assert.equal(
      document.querySelectorAll('[aria-label="Private"] [data-session-id]').length,
      5,
      "changing the limit closes Show more",
    );
    setValue("Sort Private", "name");
    assert.equal(
      document.querySelector('[aria-label="Private"] [data-session-id]')?.getAttribute("data-session-id"),
      "s0",
    );
    setValue("Sort Private", "recent");
    assert.equal(
      document.querySelector('[aria-label="Private"] [data-session-id]')?.getAttribute("data-session-id"),
      "s11",
    );
    setValue("Show items in Private", "10");
    button("Options for Private section").click();

    toggleSidebarCustomization();
    submit("New tab name", "Focus");
    const focusTab = sidebarState.layout.activeTab;
    setValue("Icon for Focus tab", "🚀");
    setValue("Shortcut destination", "project:group:Alpha");
    button("Add shortcut").click();
    setValue("Rename Alpha shortcut", "Open Alpha");
    setValue("Icon for Open Alpha shortcut", "🧭");
    setValue("New section content", "chats");
    submit("New section name", "Recent work");
    const viewSection = sidebarState.layout.sections.find(
      (section: { name: string }) => section.name === "Recent work",
    )!;
    toggleSidebarCustomization();
    assert.equal(document.querySelectorAll('[aria-label="Recent work"] [data-session-id]').length, 10);
    assert.equal(document.querySelector('[aria-label="Private"]'), null);
    button("Options for Recent work section").click();
    setValue("Filter Recent work", "Chat 11");
    assert.equal(document.querySelectorAll('[aria-label="Recent work"] [data-session-id]').length, 1);
    setValue("Status for Recent work", "waiting");
    assert.equal(document.querySelectorAll('[aria-label="Recent work"] [data-session-id]').length, 0);
    setValue("Status for Recent work", "all");
    setValue("Project for Recent work", "group:Alpha");
    assert.equal(document.querySelectorAll('[aria-label="Recent work"] [data-session-id]').length, 0);
    const visibleContexts = contextsState.list;
    contextsState.list = [];
    renderList();
    await settle();
    assert.equal(
      document.querySelector<HTMLSelectElement>('[aria-label="Project for Recent work"]')!.selectedOptions[0]!
        .textContent,
      "Unavailable project",
    );
    setValue("Project for Recent work", "");
    contextsState.list = visibleContexts;
    renderList();
    await settle();
    const customized = structuredClone(stored);
    resetSidebarState();
    await loadSidebarState();
    assert.deepEqual(sidebarState.layout, customized);
    assert.equal(sidebarState.layout.activeTab, focusTab);
    assert.equal(sidebarState.layout.tabs.find((tab: { id: string }) => tab.id === focusTab).icon, "🚀");
    assert.equal(
      sidebarState.layout.shortcuts.find((shortcut: { name: string }) => shortcut.name === "Open Alpha").icon,
      "🧭",
    );
    toggleSidebarCustomization();
    setValue("Tab for Recent work section", "home");
    assert.equal(
      sidebarState.layout.sections.find((section: { id: string }) => section.id === viewSection.id).tabId,
      "home",
    );
    button("Remove Focus tab").click();
    assert.equal(sidebarState.layout.activeTab, "home");
    assert.equal(
      sidebarState.layout.shortcuts.find((shortcut: { name: string }) => shortcut.name === "Open Alpha").tabId,
      "home",
    );
    button("Remove Recent work section").click();
    toggleSidebarCustomization();

    await settle();
    const beforeOversized = structuredClone(sidebarState.layout);
    const oversizedWrites = writes.length;
    updateSidebarLayout((layout: SidebarLayout) => ({
      ...layout,
      sections: layout.sections.map((section, index) => ({
        ...section,
        items: index < 3 ? Array.from({ length: 500 }, (_, i) => `web:owner:${String(i).padStart(42, "0")}`) : [],
      })),
    }));
    await settle();
    assert.match(sidebarState.notice, /fill your sidebar/);
    assert.deepEqual(sidebarState.layout, beforeOversized, "oversized edits preserve the last valid layout");
    assert.equal(writes.length, oversizedWrites, "oversized edits never reach the bounded UI-state endpoint");
    assert.equal(keepaliveWrites.at(-1), false, "regular saves do not consume the unload keepalive budget");

    failWrites = true;
    button("Private").click();
    await settle();
    assert.equal(sidebarState.notice, "", "smaller edits remain possible after reaching the limit");
    assert.match(sidebarState.error, /haven't saved/);
    failWrites = false;
    await saveSidebarState();
    assert.equal(sidebarState.error, "");
    assert.deepEqual(stored, sidebarState.layout);
    await loadSidebarState();
    assert.equal(reads, 3, "an already loaded sidebar cannot replace edited state");

    savedAt = Date.now() + 60_000;
    updateSidebarLayout((layout: SidebarLayout) => ({ ...layout, collapsedProjects: ["group:Beta"] }));
    await settle();
    assert.match(sidebarState.error, /haven't saved/);
    await saveSidebarState();
    assert.equal(sidebarState.error, "", "retry advances past the server's timestamp");
    assert.deepEqual(stored, sidebarState.layout);

    pauseWrites = true;
    updateSidebarLayout((layout: SidebarLayout) => ({ ...layout, collapsedProjects: ["group:Alpha"] }));
    updateSidebarLayout((layout: SidebarLayout) => ({ ...layout, collapsedProjects: ["group:Alpha", "group:Beta"] }));
    const beforeFlush = writes.length;
    pauseWrites = false;
    window.dispatchEvent(new Event("pagehide"));
    await settle();
    assert.equal(writes.length, beforeFlush + 1);
    assert.deepEqual((stored as SidebarLayout).collapsedProjects, ["group:Alpha", "group:Beta"]);
    assert.equal(keepaliveWrites.at(-1), true);
    (holdWrite as unknown as (response: Response) => void)(Response.json({ message: "Unavailable" }, { status: 503 }));
    await settle();
    assert.equal(writes.length, beforeFlush + 1, "late save completions cannot overwrite the flushed revision");
    assert.equal(sidebarState.error, "", "a late failure cannot report an error after the latest revision saved");

    pauseWrites = true;
    updateSidebarLayout((layout: SidebarLayout) => ({ ...layout, collapsedProjects: ["group:Alpha"] }));
    updateSidebarLayout((layout: SidebarLayout) => ({ ...layout, collapsedProjects: ["group:Alpha", "group:Beta"] }));
    assert.ok(holdWrite);
    const beforeReset = writes.length;
    resetSidebarState();
    (holdWrite as (response: Response) => void)(Response.json({ ok: true }));
    await settle();
    assert.equal(writes.length, beforeReset, "an old save cannot flush another user's pending state");
    assert.equal(sidebarState.loaded, false);
  } finally {
    await vite.close();
  }
});
