import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { createServer } from "vite";

test("sent view pages Gmail messages and opens the matching Google account", async () => {
  const domErrors: Error[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => domErrors.push(error));
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/",
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
  ])
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
    const {
      loadSentMail,
      sentMailTpl,
      sentEmailPageTpl,
      resetSentMail,
      openSentEmail,
      openSentEmailById,
      selectedSentEmail,
      sentChatTpl,
    } = await vite.ssrLoadModule("/src/sent-mail.ts");
    const { html, render } = await vite.ssrLoadModule("lit");
    const host = document.getElementById("main")!;
    const draw = () => render(sentMailTpl(draw), host);
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      if (String(input).endsWith("/sent-seed.local.json")) return new Response(null, { status: 404 });
      const next = String(input).includes("pageToken=");
      return Response.json({
        accountEmail: "sam@example.com",
        messages: [
          {
            id: next ? "older" : "newer",
            threadId: "thread-1",
            to: "Alex",
            subject: "Hello",
            snippet: "A &amp; B",
            sentAt: next ? 1000 : 2000,
          },
        ],
        ...(next ? {} : { nextPageToken: "cursor" }),
      });
    };
    await loadSentMail(draw);
    assert.match(host.textContent!, /A & B/);
    assert.equal(host.querySelector("a"), null);
    await loadSentMail(draw, true);
    assert.equal(host.querySelectorAll(".inbox-sent-row").length, 2);
    const sentRow = host.querySelector(".inbox-sent-row")!;
    assert.ok(sentRow.closest(".inbox-item")!.classList.contains("src-gmail"));
    assert.equal(sentRow.querySelector(".inbox-item-glyph svg")!.getAttribute("width"), "14");
    assert.match(urls.at(-1)!, /accountType=default/);
    assert.match(urls.at(-1)!, /pageToken=cursor/);
    assert.equal(host.querySelector(".inbox-sent-more"), null);
    let chatRequest: Record<string, unknown> = {};
    globalThis.fetch = async (input, options) => {
      if (String(input).endsWith("/inbox/sent-chat")) {
        chatRequest = JSON.parse(String(options?.body));
        return Response.json({ item: { id: "company-chat", thread: [] } });
      }
      if (String(input).endsWith("/sent-seed.local.json")) return new Response(null, { status: 404 });
      assert.match(String(input), /accountType=company$/);
      return Response.json({
        id: "newer",
        accountType: "company",
        threadId: "thread-1",
        from: "Sam",
        cc: "",
        body: "Full sent body",
        html: false,
        attachments: [],
      });
    };
    await openSentEmail(
      {
        id: "newer",
        accountType: "company",
        threadId: "thread-1",
        to: "Alex",
        subject: "Hello",
        snippet: "",
        sentAt: 2000,
      },
      draw,
    );
    assert.equal(chatRequest.accountType, "company");
    assert.equal(chatRequest.messageId, "newer");
    render(sentEmailPageTpl(draw, html`<div class="inbox-chat">Assistant</div>`), host);
    assert.equal(host.querySelector(".inbox-context-text")!.textContent, "Full sent body");
    assert.ok(host.querySelector(".pane-head.inbox-item-head"));
    assert.ok(host.querySelector(".inbox-surface.inbox-item-surface"));
    assert.equal(host.querySelector(".inbox-item-aside")!.textContent, "Assistant");
    assert.ok(host.querySelector(".inbox-item-thread > :last-child")!.classList.contains("inbox-sent-actions"));
    assert.match(host.querySelector("a")!.href, /authuser=sam%40example.com/);
    (host.querySelector(".context-back") as HTMLButtonElement).click();
    render(sentMailTpl(draw), host);
    assert.equal(host.querySelectorAll(".inbox-sent-row").length, 2);
    resetSentMail();
    let detailRequest = "";
    globalThis.fetch = async (input) => {
      if (String(input).endsWith("/sent-seed.local.json")) return new Response(null, { status: 404 });
      if (String(input).endsWith("/inbox/sent-chat")) return Response.json({ item: { id: "chat", thread: [] } });
      detailRequest = String(input);
      return Response.json({
        id: "unlisted",
        threadId: "thread-unlisted",
        to: "Alex",
        subject: "Direct link",
        snippet: "",
        sentAt: 2000,
        from: "Sam",
        cc: "",
        body: "Loaded without listing",
        html: false,
        attachments: [],
      });
    };
    await openSentEmailById("unlisted", draw);
    assert.match(detailRequest, /\/api\/inbox\/sent\/unlisted\?accountType=default$/);
    render(sentEmailPageTpl(draw), host);
    assert.match(host.textContent!, /Direct link/);
    assert.match(host.textContent!, /Loaded without listing/);
    assert.equal(selectedSentEmail().id, "unlisted");
    render(
      sentEmailPageTpl(
        draw,
        sentChatTpl(draw, (item: { id: string }) => html`<div class="verified-chat">Chat ${item.id}</div>`),
      ),
      host,
    );
    assert.equal(host.querySelector(".inbox-item-aside .verified-chat")!.textContent, "Chat chat");
    resetSentMail();
    const seeded = {
      accountEmail: "sam@example.com",
      messages: [
        {
          id: "seeded",
          threadId: "thread-seeded",
          to: "Alex",
          subject: "Seeded thread",
          snippet: "First message",
          sentAt: 2000,
          conversation: [
            { from: "Sam", to: "Alex", sentAt: 1000, body: "First message" },
            { from: "Alex", to: "Sam", sentAt: 2000, body: "Second message", attachments: ["mockup.pdf"] },
          ],
        },
      ],
    };
    globalThis.fetch = async () => Response.json(seeded);
    await loadSentMail(draw);
    await openSentEmail(seeded.messages[0], draw);
    render(sentEmailPageTpl(draw), host);
    assert.equal(host.querySelectorAll(".inbox-sent-message").length, 2);
    assert.match(host.textContent!, /First message/);
    assert.match(host.textContent!, /Second message/);
    assert.match(host.textContent!, /mockup\.pdf/);
    resetSentMail();
    globalThis.fetch = async () => {
      throw new Error("Connect Google");
    };
    await loadSentMail(draw);
    assert.match(host.querySelector('[role="alert"]')!.textContent!, /Connect Google/);
    assert.equal(host.querySelectorAll(".inbox-sent-row").length, 0);
    resetSentMail();
    assert.deepEqual(domErrors, []);
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
    dom.window.close();
  }
});
