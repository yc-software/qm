import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("owner-only inline project title rename: affordance, save/cancel/blank/unchanged/error/busy, and sidebar propagation", async () => {
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
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLDialogElement: dom.window.HTMLDialogElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    SubmitEvent: dom.window.SubmitEvent,
    InputEvent: dom.window.InputEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const owner = { scopeId: "project:owned", kind: "personal", name: null, sessionCount: 0, lastActivityAt: null };
  const ownedProject = {
    id: "project-owned",
    name: "Launch planning",
    ownerId: "owner",
    memberIds: ["owner"],
    scopeId: "project:owned",
    members: [{ principalId: "owner", displayName: "Owner" }],
  };
  const ownedContext = { ...owner, project: ownedProject };
  const other = { scopeId: "project:other", kind: "personal", name: null, sessionCount: 0, lastActivityAt: null };
  const otherProject = {
    id: "project-other",
    name: "Someone else's project",
    ownerId: "not-me",
    memberIds: ["owner", "not-me"],
    scopeId: "project:other",
    members: [
      { principalId: "not-me", displayName: "Not Me" },
      { principalId: "owner", displayName: "Owner" },
    ],
  };
  const otherContext = { ...other, project: otherProject };

  let patchCalls = 0;
  let lastPatchBody: { name?: string } | null = null;
  // Toggle between throwing (simulated failure) and succeeding, and let a single
  // in-flight request be held open on demand to inspect the busy-disabled UI.
  let patchShouldFail = false;
  let holdPatch: { resolve: () => void } | null = null;

  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path === "/api/contexts") return Response.json({ contexts: [ownedContext, otherContext] });
    if (path === "/api/sessions") return Response.json({ sessions: [] });
    if (path === "/api/projects/project-owned" && init?.method === "PATCH") {
      patchCalls++;
      lastPatchBody = JSON.parse(String(init.body));
      if (holdPatch) {
        await new Promise<void>((resolve) => {
          holdPatch = { resolve };
        });
      }
      if (patchShouldFail) return new Response(JSON.stringify({ message: "name already in use" }), { status: 409 });
      const updated = { ...ownedProject, name: lastPatchBody!.name };
      return Response.json({ project: updated });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { contextsState, renderContexts, resetContextsState } = await vite.ssrLoadModule("/src/contexts.ts");
    appState.me = { user: "owner", org: "acme" };
    appState.currentView = "contexts";
    appState.mainEl = document.querySelector("#main");
    resetContextsState();
    contextsState.selected = "project:other";

    await renderContexts();

    // Non-owner: no rename affordance is rendered at all.
    const noEditButtonForNonOwner = document.querySelector(".project-title-edit") === null;
    assert.ok(document.querySelector(".pane-title")?.textContent?.includes(otherProject.name));

    contextsState.selected = "project:owned";
    await renderContexts();

    // Owner: the idle title shows a subtle pencil affordance next to the plain name.
    const titleText = document.querySelector(".project-title-text")?.textContent;
    const editButton = document.querySelector<HTMLButtonElement>(".project-title-edit");
    const hasEditButtonForOwner = editButton !== null;

    editButton!.click();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Editing state: a focused, prefilled input plus explicit save/cancel controls.
    const input = document.querySelector<HTMLInputElement>(".project-title-input")!;
    const inputPrefilled = input.value === ownedProject.name;
    const inputFocused = document.activeElement === input;
    const hasSaveButton = document.querySelector(".project-title-save") !== null;
    const hasCancelButton = document.querySelector(".project-title-cancel") !== null;

    // Escape cancels without calling the API.
    input.value = "changed but escaped";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await Promise.resolve();
    const cancelledBackToIdle = document.querySelector(".project-title-input") === null;
    const noCallsAfterEscape = patchCalls === 0;

    // Re-open, submit blank -> validation error, no API call, stays editing.
    document.querySelector<HTMLButtonElement>(".project-title-edit")!.click();
    await Promise.resolve();
    const blankInput = document.querySelector<HTMLInputElement>(".project-title-input")!;
    blankInput.value = "   ";
    blankInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
    document
      .querySelector<HTMLFormElement>(".project-title-form")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    const blankShowsError = document.body.textContent?.includes("can't be empty") === true;
    const staysEditingAfterBlank = document.querySelector(".project-title-input") !== null;
    const noCallOnBlank = patchCalls === 0;

    // Unchanged name -> exits editing quietly without an API call.
    const unchangedInput = document.querySelector<HTMLInputElement>(".project-title-input")!;
    unchangedInput.value = ownedProject.name;
    unchangedInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
    document
      .querySelector<HTMLFormElement>(".project-title-form")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    const exitsOnUnchanged = document.querySelector(".project-title-input") === null;
    const noCallOnUnchanged = patchCalls === 0;

    // Real rename attempt that fails server-side: draft is preserved, error is shown,
    // and the busy guard disables the controls while the request is in flight.
    document.querySelector<HTMLButtonElement>(".project-title-edit")!.click();
    await Promise.resolve();
    patchShouldFail = true;
    let release!: () => void;
    holdPatch = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      if (path === "/api/projects/project-owned" && init?.method === "PATCH") {
        patchCalls++;
        lastPatchBody = JSON.parse(String(init.body));
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return new Response(JSON.stringify({ message: "name already in use" }), { status: 409 });
      }
      return originalFetch(input, init);
    };
    const failInput = document.querySelector<HTMLInputElement>(".project-title-input")!;
    failInput.value = "Renamed launch planning";
    failInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
    document
      .querySelector<HTMLFormElement>(".project-title-form")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    const busyDisablesInput = document.querySelector<HTMLInputElement>(".project-title-input")!.disabled === true;
    const busyDisablesSave = document.querySelector<HTMLButtonElement>(".project-title-save")!.disabled === true;
    release();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const staysEditingAfterFailure = document.querySelector(".project-title-input") !== null;
    const draftPreservedAfterFailure =
      document.querySelector<HTMLInputElement>(".project-title-input")!.value === "Renamed launch planning";
    const errorShownAfterFailure = document.body.textContent?.includes("Couldn't rename this project") === true;
    globalThis.fetch = originalFetch;

    // Retry succeeds: title updates in the header and propagates to the shared
    // contexts list the sidebar reads from, and editing closes.
    patchShouldFail = false;
    document
      .querySelector<HTMLFormElement>(".project-title-form")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const successClosesEditing = document.querySelector(".project-title-input") === null;
    const headerShowsNewName = document.querySelector(".project-title-text")?.textContent === "Renamed launch planning";
    const propagatedToSharedList = contextsState.list.find((c: { scopeId: string }) => c.scopeId === "project:owned")
      ?.project?.name;

    assert.deepEqual(
      {
        noEditButtonForNonOwner,
        hasEditButtonForOwner,
        titleText,
        inputPrefilled,
        inputFocused,
        hasSaveButton,
        hasCancelButton,
        cancelledBackToIdle,
        noCallsAfterEscape,
        blankShowsError,
        staysEditingAfterBlank,
        noCallOnBlank,
        exitsOnUnchanged,
        noCallOnUnchanged,
        busyDisablesInput,
        busyDisablesSave,
        staysEditingAfterFailure,
        draftPreservedAfterFailure,
        errorShownAfterFailure,
        successClosesEditing,
        headerShowsNewName,
        propagatedToSharedList,
      },
      {
        noEditButtonForNonOwner: true,
        hasEditButtonForOwner: true,
        titleText: "Launch planning",
        inputPrefilled: true,
        inputFocused: true,
        hasSaveButton: true,
        hasCancelButton: true,
        cancelledBackToIdle: true,
        noCallsAfterEscape: true,
        blankShowsError: true,
        staysEditingAfterBlank: true,
        noCallOnBlank: true,
        exitsOnUnchanged: true,
        noCallOnUnchanged: true,
        busyDisablesInput: true,
        busyDisablesSave: true,
        staysEditingAfterFailure: true,
        draftPreservedAfterFailure: true,
        errorShownAfterFailure: true,
        successClosesEditing: true,
        headerShowsNewName: true,
        propagatedToSharedList: "Renamed launch planning",
      },
    );
  } finally {
    await vite.close();
  }
});
