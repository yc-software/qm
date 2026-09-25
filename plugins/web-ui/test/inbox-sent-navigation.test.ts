import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { createServer } from "vite";
import { inboxRuntime } from "./inbox-composer-fixture.ts";
import type { LedgerItem } from "../src/inbox.ts";

test("Sent opens from a split pane and retains drafts and queued sends after navigation", async () => {
  const domErrors: Error[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => domErrors.push(error));
  const dom = new JSDOM('<!doctype html><div id="app"></div><main></main><div id="split"></div>', {
    url: "https://review.example/",
    virtualConsole,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  for (const key of [
    "window",
    "document",
    "location",
    "history",
    "localStorage",
    "navigator",
    "HTMLElement",
    "Node",
    "DOMParser",
    "CustomEvent",
    "Event",
    "customElements",
  ])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "window" ? dom.window : dom.window[key as keyof typeof dom.window],
    });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: dom.window.getComputedStyle.bind(dom.window),
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (fn: FrameRequestCallback) => setTimeout(() => fn(Date.now()), 0),
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: clearTimeout });
  const originalFetch = globalThis.fetch;
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  const waitFor = async (condition: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(condition());
  };
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const inbox = await vite.ssrLoadModule("/src/inbox.ts");
    const sent = await vite.ssrLoadModule("/src/sent-mail.ts");
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { splitState } = await vite.ssrLoadModule("/src/split.ts");
    const message = {
      id: "message-1",
      threadId: "thread-1",
      to: "Alex",
      subject: "Subject",
      snippet: "Sent body",
      sentAt: 1,
    };
    const ledger: LedgerItem = {
      id: "sent-ledger",
      loopId: "loop-1",
      dedupeKey: "sent-chat:thread-1",
      state: "held",
      source: "gmail",
      sourcePayload: {
        sentChat: true,
        title: "Subject",
        from: "Sam",
        gmail: { threadId: "thread-1", to: ["Alex"], cc: ["Chris"] },
      },
      proposal: { data: { body: "" }, by: "human", at: 10 },
      thread: [],
      updatedAt: 10,
    };
    const actions: Array<{ kind: string; args: { proposal: Record<string, unknown>; expectedProposalAt: number } }> =
      [];
    let holdEdit = false;
    let releaseEdit: (() => void) | undefined;
    globalThis.fetch = async (input, options) => {
      const url = String(input);
      if (url.includes("runtime-config")) return Response.json({ ...inboxRuntime, scopeId: "personal:sam" });
      if (url.endsWith("/followup")) {
        const followup = JSON.parse(String(options?.body));
        assert.equal(followup.message, "Send it");
        assert.equal(followup.expectedProposalAt, ledger.proposal!.at);
        ledger.state = "actioned";
        return Response.json({ item: ledger });
      }
      if (url === "/api/inbox") return Response.json({ loop: { id: "loop-1" }, syncCron: null });
      if (url === "/api/loops/loop-1/items") return Response.json({ items: [] });
      if (url.startsWith("/api/inbox/sent?"))
        return Response.json({ messages: [message], accountType: "default", accountEmail: "sam@example.com" });
      if (url.startsWith("/api/inbox/sent/"))
        return Response.json({ ...message, from: "Sam", cc: "Chris", body: "Sent body", html: false, attachments: [] });
      if (url === "/api/inbox/sent-chat") {
        const body = JSON.parse(String(options?.body));
        assert.equal(body.accountType, "default");
        assert.equal(body.messageId, message.id);
        return Response.json({ item: ledger });
      }
      if (url.endsWith("/action")) {
        const action = JSON.parse(String(options?.body));
        actions.push(action);
        if (action.kind === "edit") {
          if (holdEdit)
            await new Promise<void>((resolve) => {
              releaseEdit = resolve;
            });
          ledger.proposal = { data: action.args.proposal, by: "human", at: ledger.proposal!.at + 1 };
        }
        if (action.kind === "send") ledger.state = "actioned";
        return Response.json({ item: ledger });
      }
      return Response.json({});
    };
    appState.me = { user: "sam", org: "test", permissions: ["inbox"] };
    appState.mainEl = document.querySelector("main");
    appState.currentView = "chats";
    splitState.active = true;
    inbox.inboxState.loaded = true;
    inbox.inboxState.loopId = "loop-1";
    inbox.inboxState.fetchedAt = Date.now();
    const pane = document.getElementById("split")!;
    const mounted = inbox.mountInboxPane({ host: pane, viewId: "all", density: () => "full", onDensityChange() {} });
    [...pane.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent!.trim() === "Sent")!
      .click();
    await waitFor(() => Boolean(pane.querySelector(".inbox-sent-row")));
    pane.querySelector<HTMLButtonElement>(".inbox-sent-row")!.click();
    await waitFor(() => Boolean(document.querySelector("main .inbox-draft-body")));
    assert.equal(appState.currentView, "inbox");
    assert.equal(splitState.active, false);
    assert.match(location.pathname, /\/inbox\/message-1$/);
    assert.match(document.querySelector("main .inbox-sent-message")!.textContent!, /Sent body/);
    assert.ok(document.querySelector("main .inbox-chat"));
    assert.deepEqual(inbox.inboxState.items, []);
    mounted.dispose();
    pane.remove();

    const bodyInput = (): HTMLTextAreaElement => document.querySelector(".inbox-draft-body")!;
    const editBody = (value: string): void => {
      bodyInput().value = value;
      bodyInput().dispatchEvent(new dom.window.Event("input"));
    };
    const close = (): void => document.querySelector<HTMLButtonElement>(".context-back")!.click();
    editBody("Save without blur");
    close();
    await waitFor(() => ledger.proposal!.data.body === "Save without blur");
    assert.equal(sent.selectedSentChat(), null);
    assert.equal(actions.length, 1);

    await sent.openSentEmail(message, inbox.drawAll);
    editBody("Queued save");
    bodyInput().dispatchEvent(new dom.window.Event("blur"));
    inbox.routeInboxHistory("sent");
    await waitFor(() => ledger.proposal!.data.body === "Queued save");
    assert.equal(actions.length, 2);

    await sent.openSentEmail(message, inbox.drawAll);
    editBody("Saving first version");
    holdEdit = true;
    bodyInput().dispatchEvent(new dom.window.Event("blur"));
    await waitFor(() => Boolean(releaseEdit));
    editBody("Send the latest version");
    const recipients = '"Doe, Jane" <jane@example.com>, Alex <alex@example.com>';
    const headers = document.querySelectorAll<HTMLInputElement>(".inbox-draft-headers input");
    for (const header of [headers[0]!, headers[1]!]) {
      header.value = recipients;
      header.dispatchEvent(new dom.window.Event("input"));
    }
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent!.trim() === "Send it")!
      .click();
    inbox.selectInboxView("all");
    inbox.drawAll();
    holdEdit = false;
    releaseEdit!();
    await waitFor(() => ledger.state === "actioned");
    assert.deepEqual(
      actions.map((action) => action.kind),
      ["edit", "edit", "edit", "edit"],
    );
    assert.equal(actions.at(-1)!.args.proposal.body, "Send the latest version");
    assert.equal(actions.at(-1)!.args.expectedProposalAt, ledger.proposal!.at - 1);
    assert.deepEqual(actions.at(-1)!.args.proposal.to, [recipients]);
    assert.deepEqual(actions.at(-1)!.args.proposal.cc, [recipients]);
    assert.equal(ledger.state, "actioned");
    inbox.resetInboxState();
    assert.deepEqual(domErrors, []);
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
    dom.window.close();
  }
});
