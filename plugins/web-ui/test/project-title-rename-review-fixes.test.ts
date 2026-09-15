import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer, type ViteDevServer } from "vite";

// Shared harness: same JSDOM + vite.ssrLoadModule pattern as
// test/project-interactions.test.ts and test/project-title-rename.test.ts, loading the
// real contexts.ts module so these are real-DOM regression tests, not source matching.
async function setupHarness(): Promise<{
  vite: ViteDevServer;
  appState: { me: unknown; currentView: string; mainEl: HTMLElement | null; viewRenderSeq: number };
  contextsState: {
    selected: string | null;
    list: unknown[];
    titleEditing: boolean;
    titleValue: string;
    titleBusy: boolean;
    titleError: string;
  };
  renderContexts: () => Promise<void>;
}> {
  const dom = new JSDOM(
    '<!doctype html><button id="outside">Outside focus target</button><div id="app"></div><main id="main"></main>',
    {
      url: "http://localhost/web-ui/?view=contexts",
    },
  );
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

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
  const { contextsState, renderContexts } = await vite.ssrLoadModule("/src/contexts.ts");
  appState.me = { user: "owner", org: "acme" };
  appState.currentView = "contexts";
  appState.mainEl = document.querySelector("#main");
  return { vite, appState, contextsState, renderContexts };
}

function makeProject(id: string, name: string, ownerId: string) {
  return {
    id,
    name,
    ownerId,
    memberIds: [ownerId],
    scopeId: `project:${id}`,
    members: [{ principalId: ownerId, displayName: ownerId === "owner" ? "Owner" : ownerId }],
  };
}

function contextFor(project: ReturnType<typeof makeProject>) {
  return {
    scopeId: project.scopeId,
    kind: "personal" as const,
    name: null,
    sessionCount: 0,
    lastActivityAt: null,
    project,
  };
}

function clickRowFor(name: string): void {
  const row = [...document.querySelectorAll<HTMLButtonElement>(".context-row")].find((el) =>
    el.textContent?.includes(name),
  );
  if (!row) throw new Error(`no .context-row for ${name}`);
  row.click();
}

function submitTitleForm(): void {
  document
    .querySelector<HTMLFormElement>(".project-title-form")!
    .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
}

function setTitleInput(value: string): void {
  const input = document.querySelector<HTMLInputElement>(".project-title-input")!;
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

// Opening the editor focuses+selects the input via requestAnimationFrame (see
// beginProjectTitleRename), which our test globals resolve on a real macrotask, not
// synchronously. Wait for it so the "currently focused element" driving the
// preserve-focus behavior under test is actually the input, matching real usage.
async function clickPencil(): Promise<void> {
  document.querySelector<HTMLButtonElement>(".project-title-edit")!.click();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// A real commit chains several awaits (fetch -> webFetch -> api -> renameProject ->
// commitProjectTitleRename), and its own focus fallback is itself queued one
// requestAnimationFrame after that. Give the event loop several microtask+macrotask
// rounds to fully drain both before asserting on the settled DOM/focus state.
async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test("stale rename completions never clobber a different project's draft, or a fresh reopened draft on the same project (A -> B, A -> B -> A)", async () => {
  const { vite, contextsState, renderContexts } = await setupHarness();
  try {
    const projectA = makeProject("a", "Project A", "owner");
    const projectB = makeProject("b", "Project B", "owner");
    const contexts = [contextFor(projectA), contextFor(projectB)];

    let heldA: { resolve: (r: Response) => void }[] = [];
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      if (path === "/api/contexts") return Response.json({ contexts });
      if (path === "/api/sessions") return Response.json({ sessions: [] });
      if (path.startsWith("/api/scope-resources"))
        return Response.json({ files: [], webhooks: [], crons: [], deployments: [], skills: [], manageable: true });
      if (path === "/api/projects/a" && init?.method === "PATCH") {
        return new Promise<Response>((resolve) => heldA.push({ resolve }));
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    };

    contextsState.selected = null;
    await renderContexts();

    // Open A, start a save, and leave it hanging (simulates a slow network).
    clickRowFor("Project A");
    document.querySelector<HTMLButtonElement>(".project-title-edit")!.click();
    setTitleInput("A renamed while B is untouched");
    submitTitleForm();
    await Promise.resolve();
    assert.equal(heldA.length, 1, "A's save should be in flight");

    // Navigate away to B before A responds, and start a fresh, different draft there.
    document.querySelector<HTMLButtonElement>(".context-back")!.click();
    clickRowFor("Project B");
    document.querySelector<HTMLButtonElement>(".project-title-edit")!.click();
    setTitleInput("B's own draft");

    // A's slow save now resolves successfully. It must not touch B's open draft.
    heldA[0]!.resolve(Response.json({ project: { ...projectA, name: "A renamed while B is untouched" } }));
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(
      {
        stillEditingB: contextsState.titleEditing,
        bDraftIntact: contextsState.titleValue,
        noErrorLeakedUnderB: contextsState.titleError,
        bInputStillShowsDraft: document.querySelector<HTMLInputElement>(".project-title-input")?.value,
      },
      {
        stillEditingB: true,
        bDraftIntact: "B's own draft",
        noErrorLeakedUnderB: "",
        bInputStillShowsDraft: "B's own draft",
      },
      "A's late success must not close B's editor, touch B's draft, or leave an error under B",
    );
    // The rename itself is still real and must have landed in the shared list, just not
    // in the ephemeral per-editor UI fields that now belong to B's session.
    const updatedA = (contextsState.list as Array<{ scopeId: string; project?: { name: string } }>).find(
      (c) => c.scopeId === "project:a",
    );
    assert.equal(updatedA?.project?.name, "A renamed while B is untouched");

    // Now: A -> B -> A again, with a brand new draft, and prove a second stale
    // response (from a request left over from a still-earlier attempt) can't land either.
    // A's display name in the grid is now whatever the first rename above landed it at.
    heldA = [];
    document.querySelector<HTMLButtonElement>(".context-back")!.click();
    clickRowFor("A renamed while B is untouched");
    document.querySelector<HTMLButtonElement>(".project-title-edit")!.click();
    setTitleInput("first retry on A");
    submitTitleForm();
    await Promise.resolve();
    const firstRetryRequest = heldA[0]!;
    heldA = [];

    // Leave, come back, and open a completely fresh edit on A before that request answers.
    // The grid still shows the pre-"first retry" name here because that request is the
    // one being held open below — it hasn't resolved (and so hasn't updated the list) yet.
    document.querySelector<HTMLButtonElement>(".context-back")!.click();
    clickRowFor("A renamed while B is untouched");
    document.querySelector<HTMLButtonElement>(".project-title-edit")!.click();
    setTitleInput("second, newer draft on A");

    firstRetryRequest.resolve(Response.json({ project: { ...projectA, name: "first retry on A" } }));
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(
      {
        stillEditingNewSession: contextsState.titleEditing,
        newDraftIntact: contextsState.titleValue,
        noErrorFromOldRequest: contextsState.titleError,
      },
      { stillEditingNewSession: true, newDraftIntact: "second, newer draft on A", noErrorFromOldRequest: "" },
      "a stale response from an earlier A edit session must not touch a freshly reopened A edit session (A -> B -> A)",
    );
  } finally {
    await vite.close();
  }
});

test("focus is restored predictably after every exit path, and a slow save never steals focus back from elsewhere on the page", async () => {
  const { vite, contextsState, renderContexts } = await setupHarness();
  try {
    const project = makeProject("focus", "Focus Test Project", "owner");
    const contexts = [contextFor(project)];
    let held: { resolve: (r: Response) => void }[] = [];
    let shouldFail = false;
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      if (path === "/api/contexts") return Response.json({ contexts });
      if (path === "/api/sessions") return Response.json({ sessions: [] });
      if (path.startsWith("/api/scope-resources"))
        return Response.json({ files: [], webhooks: [], crons: [], deployments: [], skills: [], manageable: true });
      if (path === "/api/projects/focus" && init?.method === "PATCH") {
        return new Promise<Response>((resolve) => held.push({ resolve }));
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    };

    contextsState.selected = "project:focus";
    await renderContexts();

    const classOf = (): string | undefined => (document.activeElement as HTMLElement | null)?.className;

    // Escape -> pencil.
    await clickPencil();
    document
      .querySelector<HTMLInputElement>(".project-title-input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await Promise.resolve();
    assert.match(classOf() ?? "", /project-title-edit/, "Escape should return focus to the pencil");

    // Cancel button click -> pencil.
    await clickPencil();
    document.querySelector<HTMLButtonElement>(".project-title-cancel")!.click();
    await Promise.resolve();
    assert.match(classOf() ?? "", /project-title-edit/, "clicking Cancel should return focus to the pencil");

    // Blank submit -> stays editing, focus stays in the input (not the vanished pencil).
    await clickPencil();
    setTitleInput("   ");
    submitTitleForm();
    await Promise.resolve();
    assert.equal(contextsState.titleEditing, true, "blank submit stays in edit mode");
    assert.match(classOf() ?? "", /project-title-input/, "blank submit should keep focus in the input to fix the typo");

    // Unchanged name -> exits, focus -> pencil.
    setTitleInput(project.name);
    submitTitleForm();
    await Promise.resolve();
    assert.equal(contextsState.titleEditing, false, "unchanged submit exits editing");
    assert.match(classOf() ?? "", /project-title-edit/, "unchanged submit should return focus to the pencil");

    // Real (slow) successful save -> after the async round trip, focus -> pencil.
    await clickPencil();
    setTitleInput("Focus Test Project renamed");
    submitTitleForm();
    await Promise.resolve();
    assert.equal(document.activeElement, document.body, "the busy-disabled inputs drop focus to <body> mid-flight");
    held[0]!.resolve(Response.json({ project: { ...project, name: "Focus Test Project renamed" } }));
    held = [];
    await settle();
    assert.match(classOf() ?? "", /project-title-edit/, "a real successful save should restore focus to the pencil");

    // Real (slow) failed save -> focus -> input, draft preserved.
    await clickPencil();
    setTitleInput("this one will fail");
    submitTitleForm();
    await Promise.resolve();
    shouldFail = true;
    held[0]!.resolve(
      shouldFail ? new Response(JSON.stringify({ message: "nope" }), { status: 409 }) : Response.json({}),
    );
    held = [];
    await settle();
    assert.equal(contextsState.titleEditing, true, "a failed save stays in edit mode");
    assert.match(classOf() ?? "", /project-title-input/, "a real failed save should restore focus to the input");

    // Back out of that failed attempt before starting the next scenario.
    document.querySelector<HTMLButtonElement>(".project-title-cancel")!.click();
    await Promise.resolve();

    // A slow save must never steal focus from somewhere else the user has since moved to.
    await clickPencil();
    setTitleInput("should not steal focus");
    submitTitleForm();
    await Promise.resolve();
    const outside = document.querySelector<HTMLButtonElement>("#outside")!;
    outside.focus();
    assert.equal(document.activeElement, outside);
    held[0]!.resolve(Response.json({ project: { ...project, name: "should not steal focus" } }));
    await settle();
    assert.equal(
      document.activeElement,
      outside,
      "a slow save resolving after the user focused something else must not steal focus back",
    );
  } finally {
    await vite.close();
  }
});

test("a cheap ownership recheck on refresh hides/cancels an open title editor once the signed-in user is no longer the owner", async () => {
  const { vite, contextsState, renderContexts } = await setupHarness();
  try {
    const project = makeProject("owned-then-not", "Transfer Test", "owner");
    let ownerId = "owner";
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      if (path === "/api/contexts")
        return Response.json({
          contexts: [contextFor({ ...project, ownerId })],
        });
      if (path === "/api/sessions") return Response.json({ sessions: [] });
      if (path.startsWith("/api/scope-resources"))
        return Response.json({ files: [], webhooks: [], crons: [], deployments: [], skills: [], manageable: true });
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    };

    contextsState.selected = "project:owned-then-not";
    await renderContexts();
    document.querySelector<HTMLButtonElement>(".project-title-edit")!.click();
    setTitleInput("mid-edit when ownership changes");
    assert.equal(contextsState.titleEditing, true);
    assert.ok(document.querySelector(".project-title-input"), "editor is open before the ownership change");

    // Ownership changes elsewhere; the next refresh (e.g. window focus) picks it up.
    ownerId = "someone-else";
    await renderContexts();

    assert.deepEqual(
      {
        stillEditing: contextsState.titleEditing,
        draftCleared: contextsState.titleValue,
        noPencilForNonOwner: document.querySelector(".project-title-edit") === null,
        noInputLeftOpen: document.querySelector(".project-title-input") === null,
      },
      { stillEditing: false, draftCleared: "", noPencilForNonOwner: true, noInputLeftOpen: true },
      "losing ownership while the editor is open should hide/cancel it on the next refresh",
    );
  } finally {
    await vite.close();
  }
});

test("only the idle pencil carries the hover-revealed opacity class; Save/Cancel are always visible while editing", async () => {
  // shell.css scopes the opacity-0-until-hover/focus rule (and its `@media (hover: none)`
  // touch fallback) to `.project-detail-title .project-title-edit` specifically — not the
  // broader `.project-detail-title .project-icon-button`, which would also match the Save
  // and Cancel buttons rendered inside the same `.project-detail-title` and make them fade
  // out whenever the mouse isn't literally over the title (including while the input has
  // focus, since focus-visible only lights up the one focused button). This is a real-DOM
  // structural check for that scoping; actual CSS media-query cascade evaluation isn't
  // available in this JSDOM/vite unit-test harness — a real-browser touch/no-hover render
  // was attempted but this sandbox has no way to force `(hover: none)` (no CDP
  // Emulation.setEmulatedMedia, and no way to create a `hasTouch` browser context), so this
  // is the closest automated regression coverage available for that selector scoping.
  const { vite, contextsState, renderContexts } = await setupHarness();
  try {
    const project = makeProject("scope", "CSS Scope Test", "owner");
    const contexts = [contextFor(project)];
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      if (path === "/api/contexts") return Response.json({ contexts });
      if (path === "/api/sessions") return Response.json({ sessions: [] });
      if (path.startsWith("/api/scope-resources"))
        return Response.json({ files: [], webhooks: [], crons: [], deployments: [], skills: [], manageable: true });
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    };

    contextsState.selected = "project:scope";
    await renderContexts();
    const pencil = document.querySelector<HTMLButtonElement>(".project-title-edit")!;
    assert.equal(pencil.classList.contains("project-title-edit"), true);

    await clickPencil();
    const save = document.querySelector<HTMLButtonElement>(".project-title-save")!;
    const cancel = document.querySelector<HTMLButtonElement>(".project-title-cancel")!;
    assert.deepEqual(
      {
        saveCarriesEditClass: save.classList.contains("project-title-edit"),
        cancelCarriesEditClass: cancel.classList.contains("project-title-edit"),
        bothStillIconButtons:
          save.classList.contains("project-icon-button") && cancel.classList.contains("project-icon-button"),
      },
      { saveCarriesEditClass: false, cancelCarriesEditClass: false, bothStillIconButtons: true },
      "Save/Cancel must not carry the opacity-hiding class, only the sizing one",
    );
  } finally {
    await vite.close();
  }
});
