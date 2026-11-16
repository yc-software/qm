import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { testViteServer } from "./vite-server.ts";

test("conversation details include the waiting message after prior context with correctly routed attachments", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  for (const key of ["window", "document", "location", "history", "localStorage", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "window" ? dom.window : dom.window[key as keyof typeof dom.window],
    });
  const vite = await testViteServer();
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { contextTpl, toInboxItem } = await vite.ssrLoadModule("/src/inbox.ts");
    const { render } = await vite.ssrLoadModule("lit");
    const host = dom.window.document.getElementById("main")!;
    const waiting = {
      author: "Sam",
      at: 2000,
      text: "Latest waiting message",
      images: ["https://example.com/latest.png"],
    };
    for (const source of ["slack", "gmail"]) {
      for (const context of [
        undefined,
        [],
        [{ author: "Alex", at: 1000, text: "Earlier message", images: ["https://example.com/old.png"] }, waiting],
      ]) {
        const item = toInboxItem({
          id: "item-1",
          loopId: "loop-1",
          dedupeKey: "conversation-1",
          state: "held",
          source,
          sourcePayload: {
            title: "Conversation",
            from: "Sam",
            snippet: "Latest waiting message",
            receivedAt: 2000,
            context,
            images: ["https://example.com/latest.png"],
          },
          sourceAt: 2000,
          updatedAt: 3000,
          thread: [],
        });
        assert.equal(item.source, source);
        render(contextTpl(item), host);
        assert.deepEqual(
          [...host.querySelectorAll(".inbox-context-text")].map((el) => el.textContent?.trim()),
          context?.length ? ["Earlier message", "Latest waiting message"] : ["Latest waiting message"],
        );
        const messages = host.querySelectorAll(".inbox-context-msg");
        const latest = messages[messages.length - 1]!;
        assert.equal(latest.querySelector(".inbox-context-author")?.textContent, "Sam");
        assert.ok(latest.querySelector(".inbox-context-at"));
        assert.equal(
          latest.querySelector("img")?.getAttribute("src"),
          `/api/loops/loop-1/items/item-1/image?ctx=${context?.length ? 1 : -1}&i=0`,
        );
        if (context?.length)
          assert.equal(
            messages[0]!.querySelector("img")?.getAttribute("src"),
            "/api/loops/loop-1/items/item-1/image?ctx=0&i=0",
          );
        assert.equal(item.context, context);
      }
      const cut = toInboxItem({
        id: "item-2",
        loopId: "loop-1",
        dedupeKey: "conversation-2",
        state: "held",
        source,
        sourcePayload: {
          title: "Long one",
          from: "Sam",
          snippet: "tail",
          receivedAt: 2000,
          sourceContextPartial: true,
        },
        sourceAt: 2000,
        updatedAt: 3000,
        thread: [],
      });
      render(contextTpl(cut), host);
      assert.equal(
        host.querySelector(".inbox-source-notice")?.textContent?.trim(),
        source === "slack" ? "Showing part of this conversation. Open in Slack for the full history." : undefined,
      );
    }
  } finally {
    await vite.close();
    dom.window.close();
  }
});

test("a conversation the owner answered in the source shows as replied in Handled", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  for (const key of ["window", "document", "location", "history", "localStorage", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "window" ? dom.window : dom.window[key as keyof typeof dom.window],
    });
  const vite = await testViteServer();
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { handledNoteTpl, toInboxItem } = await vite.ssrLoadModule("/src/inbox.ts");
    const { render } = await vite.ssrLoadModule("lit");
    const host = dom.window.document.getElementById("main")!;
    const base = {
      id: "item-1",
      loopId: "loop-1",
      dedupeKey: "conversation-1",
      state: "dismissed",
      sourcePayload: { title: "DM", from: "Sam", snippet: "link?", receivedAt: 2000 },
      sourceAt: 2000,
      actedAt: Date.now() - 60_000,
      updatedAt: 3000,
      thread: [],
      verdict: { state: "resolved", reason: "owner answered" },
    };
    for (const source of ["slack", "gmail"]) {
      const replied = toInboxItem({ ...base, source, actionKind: "replied", actionResult: "github.com/x/y" });
      assert.equal(replied.status, "replied");
      render(handledNoteTpl(replied), host);
      assert.match(host.textContent!, new RegExp(`You replied in ${source === "slack" ? "Slack" : "Gmail"} 1m ago`));
      assert.equal(host.querySelector(".inbox-replied-text")?.textContent?.trim(), "github.com/x/y");
      assert.ok(host.querySelector(".inbox-reopen"));
    }
    const dismissed = toInboxItem({ ...base, source: "slack", actionKind: "dismiss" });
    assert.equal(dismissed.status, "dismissed");
    render(handledNoteTpl(dismissed), host);
    assert.match(host.textContent!, /Dismissed 1m ago/);
    const gone = toInboxItem({
      ...base,
      source: "slack",
      parkedReason: "The conversation is no longer available in Slack.",
    });
    render(handledNoteTpl(gone), host);
    assert.equal(
      host.querySelector(".inbox-dismissed-reason")?.textContent,
      "The conversation is no longer available in Slack.",
    );
  } finally {
    await vite.close();
    dom.window.close();
  }
});
