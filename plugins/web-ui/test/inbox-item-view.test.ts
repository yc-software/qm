import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { createServer } from "vite";
import { createInboxFixture, inboxRuntime, until } from "./support/inbox-composer-fixture.ts";

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
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { contextTpl } = await vite.ssrLoadModule("/src/inbox-item-view.ts");
    const { toInboxItem } = await vite.ssrLoadModule("/src/inbox-model.ts");
    const { render } = await vite.ssrLoadModule("lit");
    const host = dom.window.document.getElementById("main")!;
    for (const [source, payloadSource] of [
      ["slack", undefined],
      ["gmail", undefined],
      ["slack", "gmail"],
      ["gmail", "slack"],
    ]) {
      for (const context of [
        undefined,
        [],
        [{ author: "Alex", at: 1000, text: "Earlier message", images: ["https://example.com/old.png"] }],
      ]) {
        const item = toInboxItem({
          id: "item-1",
          cronId: "cron-1",
          dedupeKey: "conversation-1",
          state: "held",
          source,
          sourcePayload: {
            source: payloadSource,
            title: "Conversation",
            from: "Sam",
            snippet: "Latest waiting message",
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
          "/api/crons/cron-1/items/item-1/image?ctx=-1&i=0",
        );
        if (context?.length)
          assert.equal(
            messages[0]!.querySelector("img")?.getAttribute("src"),
            "/api/crons/cron-1/items/item-1/image?ctx=0&i=0",
          );
        assert.equal(item.context, context);
      }
    }
    const slack = toInboxItem({
      id: "thread-item",
      cronId: "cron-1",
      dedupeKey: "GPRIVATE:1.0",
      state: "held",
      source: "slack",
      sourcePayload: {
        from: "Alex",
        snippet: "Original mention",
        slack: { channelId: "GPRIVATE", ts: "1.0" },
        context: [{ author: "Other", text: "UNRELATED CHANNEL TAIL" }],
      },
      sourceAt: 1000,
      updatedAt: 1000,
      thread: [],
    });
    render(contextTpl(slack), host);
    assert.doesNotMatch(host.textContent!, /UNRELATED CHANNEL TAIL/);
    slack.sourceContextFetched = true;
    slack.sourceContextPartial = true;
    slack.context = [
      { author: "Alex", text: "Relevant introduction", nearby: true },
      { author: "Alex", text: "Original mention" },
      { author: "Taylor", text: "Thread reply", reply: true },
    ];
    render(contextTpl(slack), host);
    assert.deepEqual(
      [...host.querySelectorAll(".inbox-context-text")].map((el) => el.textContent?.trim()),
      ["Relevant introduction", "Original mention", "Thread reply"],
    );
    assert.equal(host.querySelectorAll(".inbox-thread-reply").length, 1);
    assert.equal(host.querySelectorAll(".inbox-nearby-context").length, 1);
    assert.match(host.textContent!, /Showing part of this conversation/);
  } finally {
    await vite.close();
    dom.window.close();
  }
});

test("long Slack conversations show the latest messages and reveal earlier ones on request", async () => {
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
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { contextTpl } = await vite.ssrLoadModule("/src/inbox-item-view.ts");
    const CONTEXT_TAIL = 6;
    const { toInboxItem } = await vite.ssrLoadModule("/src/inbox-model.ts");
    const { render } = await vite.ssrLoadModule("lit");
    const host = dom.window.document.getElementById("main")!;
    const texts = (): string[] => [...host.querySelectorAll(".inbox-context-text")].map((el) => el.textContent!.trim());
    const item = (id: string, count: number) =>
      toInboxItem({
        id,
        cronId: "cron-1",
        dedupeKey: id,
        state: "held",
        source: "slack",
        sourcePayload: {
          source: "slack",
          title: "Conversation",
          from: "Sam",
          snippet: "latest",
          sourceContextFetched: true,
          context: Array.from({ length: count }, (_, i) => ({ author: "Alex", at: 1000 + i, text: `m${i}` })),
        },
        sourceAt: 2000,
        updatedAt: 3000,
        thread: [],
      });

    const short = item("short", CONTEXT_TAIL);
    render(contextTpl(short), host);
    assert.equal(texts().length, CONTEXT_TAIL);
    assert.equal(host.querySelector(".inbox-earlier"), null);

    const long = item("long", 60);
    render(contextTpl(long), host);
    assert.deepEqual(
      texts(),
      Array.from({ length: CONTEXT_TAIL }, (_, i) => `m${60 - CONTEXT_TAIL + i}`),
    );
    const earlier = host.querySelector<HTMLButtonElement>(".inbox-earlier")!;
    assert.equal(earlier.textContent!.trim(), `${60 - CONTEXT_TAIL} earlier messages`);
    earlier.click();
    render(contextTpl(long), host);
    assert.equal(texts().length, CONTEXT_TAIL + 20);
    assert.equal(texts().at(-1), "m59");
    host.querySelector<HTMLButtonElement>(".inbox-earlier")!.click();
    host.querySelector<HTMLButtonElement>(".inbox-earlier")?.click();
    render(contextTpl(long), host);
    assert.equal(texts().length, 60);
    assert.equal(texts()[0], "m0");
    assert.equal(host.querySelector(".inbox-earlier"), null);
  } finally {
    await vite.close();
  }
});

test("a failed inbox followup preserves edits made while the request was pending", async () => {
  const domErrors: Error[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => domErrors.push(error));
  const { dom, vite, host, close } = await createInboxFixture({
    dom: { url: "http://localhost/web-ui/", virtualConsole },
  });
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    appState.me = { user: "taylor@example.com" };
    const { chatTpl } = await vite.ssrLoadModule("/src/inbox-item-view.ts");
    const { toInboxItem } = await vite.ssrLoadModule("/src/inbox-model.ts");
    const { render } = await vite.ssrLoadModule("lit");
    for (const edited of [undefined, "New instruction", ""]) {
      const item = toInboxItem({
        id: `item-${String(edited)}`,
        cronId: "cron-1",
        state: "held",
        source: "slack",
        sourcePayload: { title: "Conversation", from: "Sam", snippet: "Please send the update" },
        thread: [],
      });
      let rejectRequest!: (error: Error) => void;
      globalThis.fetch = (url) =>
        String(url).includes("runtime-config")
          ? Promise.resolve(Response.json(inboxRuntime))
          : new Promise<Response>((_, reject) => {
              rejectRequest = reject;
            });
      render(chatTpl(item), host);
      await until(() => Boolean(host.querySelector(".composer-input:not(:disabled)")));
      let box = host.querySelector<HTMLTextAreaElement>(".composer-input")!;
      box.value = "Original instruction";
      box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      host.querySelector<HTMLButtonElement>(".send-btn")!.click();
      await until(() => Boolean(rejectRequest));
      box = host.querySelector<HTMLTextAreaElement>(".composer-input")!;
      assert.equal(box.disabled, false);
      if (edited !== undefined) {
        box.value = edited;
        box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      }
      rejectRequest(new Error("Request failed"));
      await until(() => Boolean(host.querySelector(".composer-error")));
      render(chatTpl(item), host);
      assert.equal(
        host.querySelector<HTMLTextAreaElement>(".composer-input")!.value,
        edited ? `Original instruction\n${edited}` : "Original instruction",
      );
    }
    assert.deepEqual(domErrors, []);
  } finally {
    await close();
  }
});
