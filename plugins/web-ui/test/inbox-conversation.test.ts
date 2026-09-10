import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("draft is the first editable chat message and Send it submits the combined instruction", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', { url: "http://localhost/" });
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
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { askAgent, chatTpl, toInboxItem, inboxState, resetInboxState } = await vite.ssrLoadModule("/src/inbox.ts");
    const { render } = await vite.ssrLoadModule("lit");
    const host = dom.window.document.getElementById("main")!;
    for (const source of ["gmail", "slack"]) {
      for (const instruction of ["", "Make it shorter"]) {
        resetInboxState();
        const ledger = {
          id: "item-1",
          loopId: "loop-1",
          state: "held",
          source,
          sourcePayload: { title: "Re: Update", from: "Sam", snippet: "Any news?" },
          proposal: {
            data: { body: "Original draft", to: ["sam@example.com"], subject: "Re: Update" },
            by: "agent",
            at: 100,
          },
          thread: [],
          updatedAt: 100,
        };
        const item = toInboxItem(ledger);
        inboxState.items = [item];
        const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
        let finish!: () => void;
        const requested = new Promise<void>((resolve) => {
          finish = resolve;
        });
        let release!: () => void;
        const response = new Promise<void>((resolve) => {
          release = resolve;
        });
        globalThis.fetch = async (url, init) => {
          const body = JSON.parse(String(init?.body));
          calls.push({ path: String(url), body });
          if (String(url).endsWith("/action")) {
            assert.equal(body.kind, "edit");
            ledger.proposal.data = body.args.proposal;
            ledger.proposal.at = 101;
          } else {
            finish();
            await response;
          }
          return new Response(JSON.stringify({ item: ledger }), { headers: { "content-type": "application/json" } });
        };
        render(chatTpl(item), host);
        const first = host.querySelector(".inbox-chat-log")!.firstElementChild!;
        const draft = first.querySelector<HTMLTextAreaElement>(".inbox-draft-body")!;
        assert.ok(draft, "draft is inside the first chat message");
        assert.equal(draft.value, "Original draft");
        draft.value = "Edited draft";
        draft.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        const input = host.querySelector<HTMLTextAreaElement>(".inbox-chat-input")!;
        input.value = instruction;
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        const send = host.querySelector<HTMLButtonElement>(".inbox-suggest-chip.primary")!;
        send.click();
        send.click();
        await requested;
        assert.deepEqual(
          calls.map((call) => call.path),
          ["/api/loops/loop-1/items/item-1/action", "/api/loops/loop-1/items/item-1/followup"],
        );
        assert.equal((calls[0]!.body.args as { proposal: { body: string } }).proposal.body, "Edited draft");
        assert.deepEqual(calls[1]!.body, {
          message: instruction ? `${instruction}\n\nSend it` : "Send it",
          expectedProposalAt: 101,
        });
        render(chatTpl(item), host);
        assert.equal(host.querySelector<HTMLButtonElement>(".inbox-suggest-chip.primary")!.disabled, true);
        assert.equal(host.querySelector<HTMLTextAreaElement>(".inbox-draft-body")!.disabled, true);
        release();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    for (const failure of ["save", "followup"]) {
      resetInboxState();
      const ledger = {
        id: `failure-${failure}`,
        loopId: "loop-1",
        state: "held",
        source: "gmail",
        sourcePayload: { title: "Update", from: "Sam", snippet: "Any news?" },
        proposal: { data: { body: "Original draft" }, by: "agent", at: 100 },
        thread: [],
        updatedAt: 100,
      };
      const item = toInboxItem(ledger);
      inboxState.items = [item];
      const calls: string[] = [];
      globalThis.fetch = async (url) => {
        calls.push(String(url));
        if (String(url).endsWith("/action"))
          return new Response(JSON.stringify({ message: "Save unavailable" }), { status: 502 });
        if (String(url).endsWith("/followup"))
          return new Response(JSON.stringify({ message: "the draft changed; review it before continuing" }), {
            status: 409,
          });
        return Response.json({
          item: { ...ledger, proposal: { ...ledger.proposal, data: { body: "New server draft" }, at: 101 } },
        });
      };
      render(chatTpl(item), host);
      if (failure === "save") {
        const draft = host.querySelector<HTMLTextAreaElement>(".inbox-draft-body")!;
        draft.value = "Keep my edit";
        draft.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      }
      await askAgent(item, "Send it");
      render(chatTpl(inboxState.items[0]), host);
      assert.equal(host.querySelector<HTMLTextAreaElement>(".inbox-chat-input")!.value, "Send it");
      assert.equal(
        host.querySelector<HTMLTextAreaElement>(".inbox-draft-body")!.value,
        failure === "save" ? "Keep my edit" : "New server draft",
      );
      assert.equal(calls.filter((path) => path.endsWith("/followup")).length, failure === "save" ? 0 : 1);
      assert.equal(host.querySelector<HTMLButtonElement>(".inbox-suggest-chip.primary")!.disabled, false);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
    dom.window.close();
  }
});
