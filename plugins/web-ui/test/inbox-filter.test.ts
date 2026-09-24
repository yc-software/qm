import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { createServer } from "vite";
import type { LedgerItem } from "../src/inbox.ts";

test("inbox filters persist, preserve Sent, and guard newly visible replies", async () => {
  const errors: Error[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main><div id="inbox"></div>', {
    url: "http://localhost/web-ui/",
    virtualConsole,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  for (const key of ["window", "document", "location", "history", "localStorage", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "window" ? dom.window : dom.window[key as keyof typeof dom.window],
    });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: dom.window.getComputedStyle.bind(dom.window),
  });
  const originalFetch = globalThis.fetch;
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  let pane: { dispose(): void } | undefined;
  let saved = "triaged";
  let failSave = false;
  const writes: unknown[] = [];
  const replyEntries = new Map<string, LedgerItem>();
  const actions: string[] = [];
  const entries = [
    { id: "question", state: "held", sourcePayload: { title: "Please review the launch plan" } },
    { id: "resolved", state: "held", sourcePayload: { title: "Thanks, all set", probablyResolved: true } },
    { id: "automated", state: "pending", sourcePayload: { title: "Your receipt", automated: true } },
    { id: "pending", state: "pending", sourcePayload: { title: "Quick question" } },
  ].map((item) => ({ loopId: "email", source: "gmail", thread: [], ...item }));
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/api/ui-state")) {
      const body = JSON.parse(String(options?.body));
      assert.equal(body.key, "inbox-filter");
      if (failSave) return Response.json({ message: "Offline" }, { status: 503 });
      writes.push(body.value);
      saved = body.value;
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith("/api/inbox")) {
      const items = entries.filter(
        (item) =>
          saved === "all" ||
          (!item.sourcePayload.automated &&
            (saved === "human" || (item.state === "held" && !item.sourcePayload.probablyResolved))),
      );
      return Response.json({
        filter: saved,
        selected: [{ id: "email", name: "Email", count: items.length }],
        available: [],
        items: url.searchParams.has("view") ? [] : items,
        total: items.length,
        nextCursor: null,
      });
    }
    const actionId = url.pathname.match(/\/items\/([^/]+)\/action$/)?.[1];
    if (actionId && replyEntries.has(actionId)) {
      const entry = replyEntries.get(actionId)!;
      const body = JSON.parse(String(options?.body));
      actions.push(body.kind);
      if (body.kind === "edit") {
        entry.proposal = { data: body.args.proposal, by: "human", at: Date.now() };
        if (entry.state === "pending") entry.state = "held";
      } else if (body.kind === "send") {
        assert.equal(entry.state, "held");
        entry.state = "actioned";
      }
      return Response.json({ item: entry });
    }
    return Response.json({});
  };
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    appState.me = { user: "alice", permissions: ["inbox"] };
    const {
      mountInboxPane,
      inboxState,
      resetInboxState,
      refreshInbox,
      itemsFor,
      toInboxItem,
      draftEditorTpl,
      drawAll,
    } = await vite.ssrLoadModule("/src/inbox.ts");
    const host = document.querySelector<HTMLElement>("#inbox")!;
    pane = mountInboxPane({ host, viewId: "all", density: () => "full", onDensityChange() {} });
    const settled = async () => {
      for (let n = 0; n < 100; n++) {
        if (!inboxState.loading && !inboxState.filterBusy) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.fail("inbox did not settle");
    };
    const button = (label: string) =>
      [...host.querySelectorAll<HTMLButtonElement>(".inbox-filters button")].find(
        (element) => element.textContent?.trim() === label,
      )!;
    const titles = () => [...host.querySelectorAll(".inbox-item-sub")].map((item) => item.textContent?.trim());
    await settled();
    assert.deepEqual(
      [...host.querySelectorAll(".inbox-filters button")].map((element) => element.textContent?.trim()),
      ["Loop triaged", "Only human", "All emails"],
    );
    assert.equal(button("Loop triaged").getAttribute("aria-pressed"), "true");
    assert.deepEqual(titles(), ["Please review the launch plan"]);
    button("Only human").click();
    await settled();
    assert.deepEqual(titles(), ["Please review the launch plan", "Thanks, all set", "Quick question"]);
    button("All emails").click();
    await settled();
    assert.equal(titles().length, 4);
    assert.equal(button("All emails").getAttribute("aria-pressed"), "true");
    assert.deepEqual(writes, ["human", "all"]);
    resetInboxState();
    await refreshInbox();
    assert.equal(button("All emails").getAttribute("aria-pressed"), "true");
    assert.equal(titles().length, 4);
    failSave = true;
    button("Loop triaged").click();
    await settled();
    assert.equal(button("All emails").getAttribute("aria-pressed"), "true");
    inboxState.items.push(
      toInboxItem({ ...entries[0], id: "sent", state: "actioned", sourcePayload: { automated: true } }),
    );
    for (const filter of ["all", "human", "triaged"]) {
      inboxState.filter = filter;
      assert.deepEqual(
        itemsFor("sent", "open").map((item: { id: string }) => item.id),
        ["sent"],
      );
    }
    const { render } = await vite.ssrLoadModule("lit");
    const editor = document.createElement("div");
    document.body.append(editor);
    inboxState.filter = "all";
    for (const state of ["processed", "failed", "pending"] as const) {
      const entry: LedgerItem = {
        id: `reply-${state}`,
        loopId: "email",
        dedupeKey: `reply-${state}`,
        source: "gmail",
        state,
        sourcePayload: { title: `Reply ${state}`, gmail: { threadId: state, to: ["sender@example.com"] } },
        thread: [],
        updatedAt: Date.now(),
        ...(state !== "pending" ? { proposal: { data: { body: "Existing draft" }, by: "human" as const, at: 1 } } : {}),
      };
      replyEntries.set(entry.id, entry);
      const item = { ...toInboxItem(entry), detailLoaded: true };
      inboxState.items.push(item);
      drawAll();
      render(draftEditorTpl(item), editor);
      const send = editor.querySelector<HTMLButtonElement>(".inbox-suggest-chip.primary")!;
      const row = [...host.querySelectorAll<HTMLElement>(".inbox-item")].find(
        (element) => element.querySelector(".inbox-item-sub")?.textContent === `Reply ${state}`,
      );
      assert.ok(row);
      if (state !== "pending") {
        assert.equal(send.disabled, true);
        assert.match(editor.querySelector('[role="status"]')!.textContent!, /Sending is unavailable/);
        assert.equal(row?.querySelector(".inbox-item-drafted"), null);
        assert.match(
          row?.querySelector(".inbox-item-state")?.textContent ?? "",
          /Preparing reply|Draft needs attention/,
        );
        send.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.deepEqual(actions, []);
      } else {
        assert.equal(send.disabled, false);
        const textarea = editor.querySelector<HTMLTextAreaElement>(".inbox-draft-body")!;
        textarea.value = "My own reply";
        textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        textarea.dispatchEvent(new dom.window.FocusEvent("blur"));
        send.click();
        for (let n = 0; n < 100 && actions.length < 2; n++) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.deepEqual(actions, ["edit", "send"]);
        assert.equal(replyEntries.get(entry.id)?.proposal?.data.body, "My own reply");
      }
    }
    editor.remove();
    assert.deepEqual(errors, []);
    resetInboxState();
  } finally {
    pane?.dispose();
    globalThis.fetch = originalFetch;
    await vite.close();
    dom.window.close();
  }
});
