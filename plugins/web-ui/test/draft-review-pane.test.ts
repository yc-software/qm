import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const LOOP_ID = "loop-inbox";

const gmailEntry = {
  id: "item-1",
  loopId: LOOP_ID,
  dedupeKey: "gmail:t1",
  state: "held",
  source: "gmail",
  sourcePayload: {
    source: "gmail",
    title: "Renewal terms",
    from: "Dana Silva",
    fromDetail: "dana@example.com",
    snippet: "Can you confirm the renewal terms by Friday?",
    receivedAt: Date.now() - 3_600_000,
    gmail: { threadId: "t1", subject: "Renewal terms", to: ["dana@example.com"] },
  },
  sourceAt: Date.now() - 3_600_000,
  proposal: {
    data: { to: ["dana@example.com"], subject: "Re: Renewal terms", body: "Confirming the terms now." },
    by: "agent",
    at: Date.now(),
    sessionId: "draft-1",
  },
  thread: [],
  updatedAt: Date.now(),
};

const handledEntry = {
  id: "item-2",
  loopId: LOOP_ID,
  dedupeKey: "slack:c1:1",
  state: "actioned",
  source: "slack",
  sourcePayload: {
    source: "slack",
    title: "deploy question",
    from: "Sam",
    snippet: "Is the deploy done?",
    receivedAt: Date.now() - 7_200_000,
    slack: { channelId: "C1", channelLabel: "#deploys", ts: "1" },
  },
  sourceAt: Date.now() - 7_200_000,
  thread: [],
  actedAt: Date.now() - 3_000_000,
  actionKind: "send",
  updatedAt: Date.now(),
};

function ledgerResponse(path: string, entries: unknown[]): Response | null {
  if (path.includes("/api/inbox")) return Response.json({ loop: { id: LOOP_ID }, syncCron: null });
  if (path.includes(`/api/loops/${LOOP_ID}/items`)) return Response.json({ items: entries, counts: {} });
  return null;
}

const draftSession = {
  id: "draft-1",
  type: "dm",
  scopeId: "personal:owner",
  threadRef: "web:owner:thread-1",
  createdAt: Date.now() - 3_500_000,
  title: "Drafting the renewal reply",
};

test("the draft review pane lists items, edits the draft, and mounts the drafting session as a real conversation", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main><div id="pane"></div>', {
    url: "http://localhost/web-ui/?view=chats",
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
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    InputEvent: dom.window.InputEvent,
    DragEvent: dom.window.Event,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  globalThis.fetch = async (input) => {
    const path = String(input);
    const ledger = ledgerResponse(path, [gmailEntry, handledEntry]);
    if (ledger) return ledger;
    if (path.includes("/api/sessions/draft-1/approvals")) return Response.json({ approvals: [] });
    if (path.includes("/api/sessions/draft-1")) return Response.json({ session: draftSession, entries: [] });
    if (path.includes("/api/sessions")) return Response.json({ sessions: [draftSession] });
    if (path.includes("/api/contexts")) return Response.json({ contexts: [] });
    if (path.includes("/api/runtime-config"))
      return Response.json({
        scopeId: "personal:owner",
        approvedHarnesses: ["pi"],
        modelsByHarness: { pi: [] },
        modelCatalog: {},
        effective: { harnessId: "pi", modelId: "default" },
        orgDefault: { harnessId: "pi", modelId: "default", revision: 1 },
        scopeOverride: null,
      });
    throw new Error(`Unexpected request: ${path}`);
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { splitState } = await vite.ssrLoadModule("/src/split.ts");
    const { sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    const { paneKindByKey } = await vite.ssrLoadModule("/src/pane-kinds.ts");
    await vite.ssrLoadModule("/src/draft-review.ts");
    appState.me = { user: "owner", org: "acme", permissions: ["inbox"] };
    appState.currentView = "chats";
    splitState.active = true;
    sessionsState.list = [draftSession];
    sessionsState.loaded = true;

    const host = document.querySelector<HTMLElement>("#pane")!;
    const pane = paneKindByKey("draftReview")!.mount({
      host,
      id: "all",
      density: () => "full",
      onDensityChange: () => {},
    });

    const until = async (ready: () => boolean, what: string): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        if (ready()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail(`timed out waiting for ${what}`);
    };

    await until(() => host.querySelector(".rv-row") !== null, "the item list");
    const segs = [...host.querySelectorAll(".rv-seg-btn")].map((b) => b.textContent?.replace(/\s+/g, "").trim());
    assert.deepEqual(segs, ["Needsyou1", "Handled1"]);

    const row = host.querySelector(".rv-row")!;
    assert.match(row.textContent ?? "", /Dana Silva/);
    assert.ok(row.querySelector(".rv-glyph svg"), "the source glyph is an inline lucide icon");
    assert.equal(row.querySelector(".rv-glyph svg")?.getAttribute("stroke"), "currentColor");

    const body = host.querySelector<HTMLTextAreaElement>(".inbox-draft-body")!;
    assert.equal(body.value, "Confirming the terms now.");
    const fieldLabels = [...host.querySelectorAll(".inbox-field span")].map((s) => s.textContent);
    assert.ok(fieldLabels.includes("To") && fieldLabels.includes("Subject"), "gmail drafts edit like email");

    await until(() => host.querySelector(".mini-convo-head") !== null, "the steering panel head");
    assert.match(host.querySelector(".mini-convo-head")!.textContent ?? "", /Drafting session/);
    await until(
      () => host.querySelector(".mini-convo .custom-chat-shell .chat-scroll") !== null,
      "the real conversation inside the steering panel",
    );
    assert.ok(
      host.querySelector(".mini-convo .custom-chat-shell .message-stack"),
      "the shell's own message stack renders",
    );
    assert.ok(host.querySelector(".mini-convo .composer-wrap"), "the shell's own composer renders");

    const handledBtn = [...host.querySelectorAll<HTMLButtonElement>(".rv-seg-btn")].find((b) =>
      (b.textContent ?? "").includes("Handled"),
    )!;
    handledBtn.click();
    await until(() => (host.querySelector(".rv-row")?.textContent ?? "").includes("#deploys"), "the handled list");
    assert.equal(host.querySelector(".mini-convo"), null, "handled items carry no steering panel");
    assert.match(host.querySelector(".inbox-handled-note")?.textContent ?? "", /Reply sent/);

    pane.dispose();
  } finally {
    await vite.close();
    dom.window.close();
  }
});

test("disposing the pane while the drafting session loads never resurrects the conversation", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main><div id="pane"></div>', {
    url: "http://localhost/web-ui/?view=chats",
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
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    InputEvent: dom.window.InputEvent,
    DragEvent: dom.window.Event,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  let transcriptRequested = false;
  let releaseTranscript = (): void => {};
  const transcriptGate = new Promise<void>((resolve) => {
    releaseTranscript = resolve;
  });
  globalThis.fetch = async (input) => {
    const path = String(input);
    const ledger = ledgerResponse(path, [gmailEntry]);
    if (ledger) return ledger;
    if (path.includes("/api/sessions/draft-1/approvals")) return Response.json({ approvals: [] });
    if (path.includes("/api/sessions/draft-1")) {
      transcriptRequested = true;
      await transcriptGate;
      return Response.json({ session: draftSession, entries: [] });
    }
    if (path.includes("/api/sessions")) return Response.json({ sessions: [draftSession] });
    if (path.includes("/api/contexts")) return Response.json({ contexts: [] });
    if (path.includes("/api/runtime-config"))
      return Response.json({
        scopeId: "personal:owner",
        approvedHarnesses: ["pi"],
        modelsByHarness: { pi: [] },
        modelCatalog: {},
        effective: { harnessId: "pi", modelId: "default" },
        orgDefault: { harnessId: "pi", modelId: "default", revision: 1 },
        scopeOverride: null,
      });
    throw new Error(`Unexpected request: ${path}`);
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { splitState } = await vite.ssrLoadModule("/src/split.ts");
    const { sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    const { allConversations } = await vite.ssrLoadModule("/src/conversations.ts");
    const { paneKindByKey } = await vite.ssrLoadModule("/src/pane-kinds.ts");
    await vite.ssrLoadModule("/src/draft-review.ts");
    appState.me = { user: "owner", org: "acme", permissions: ["inbox"] };
    appState.currentView = "chats";
    splitState.active = true;
    sessionsState.list = [draftSession];
    sessionsState.loaded = true;

    const host = document.querySelector<HTMLElement>("#pane")!;
    const pane = paneKindByKey("draftReview")!.mount({
      host,
      id: "all",
      density: () => "full",
      onDensityChange: () => {},
    });

    const until = async (ready: () => boolean, what: string): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        if (ready()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail(`timed out waiting for ${what}`);
    };

    await until(() => transcriptRequested, "the transcript request");
    const liveBefore = allConversations().length;
    assert.ok(liveBefore > 0, "the steering conversation is live while loading");

    pane.dispose();
    assert.equal(allConversations().length, liveBefore - 1, "disposing the pane releases its conversation");

    releaseTranscript();
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(host.querySelector(".mini-convo .message-stack"), null, "no transcript mounts after disposal");
    assert.equal(host.querySelector(".mini-convo .composer-wrap"), null, "no composer mounts after disposal");
    assert.equal(allConversations().length, liveBefore - 1, "nothing re-registers the disposed conversation");
  } finally {
    await vite.close();
    dom.window.close();
  }
});
