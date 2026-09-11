import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { emailDraftsIn, type EmailDraftActivity } from "../src/email-draft.ts";

test("email drafts come only from successful send_email results, one card per item", () => {
  const activity: EmailDraftActivity[] = [
    { type: "tool_call", payload: { tool: "send_email", to: ["a@b.co"] } },
    { type: "tool_result", payload: { tool: "send_email", display: { emailDraft: { loopId: "l1", itemId: "i1" } } } },
    { type: "tool_result", payload: { tool: "send_email", display: { emailDraft: { loopId: "l1", itemId: "i1" } } } },
    {
      type: "tool_result",
      payload: { tool: "send_email", isError: true, display: { emailDraft: { loopId: "l1", itemId: "i2" } } },
    },
    { type: "tool_result", payload: { tool: "miniapp", display: { emailDraft: { loopId: "l1", itemId: "i3" } } } },
    { type: "tool_result", payload: { tool: "send_email", display: { emailDraft: { loopId: "l1" } } } },
  ];
  assert.deepEqual(emailDraftsIn(activity), [{ loopId: "l1", itemId: "i1" }]);
  assert.deepEqual(emailDraftsIn(undefined), []);
});

test("the card shows the draft and sends it through the ledger only when the person clicks Send", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/?view=chats",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const keys = ["window", "document", "location", "navigator", "customElements", "HTMLElement", "Node", "Event"];
  for (const key of keys) {
    const value = dom.window[key as keyof typeof dom.window];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  let item: Record<string, unknown> = {
    id: "compose-1",
    loopId: "loop-inbox",
    dedupeKey: "compose:abc",
    state: "held",
    source: "gmail",
    sourcePayload: { source: "gmail", compose: true, title: "Q3 pricing", from: "owner@acme.co", snippet: "Hi" },
    sourceAt: 1_000,
    proposal: {
      data: {
        to: ["dana@northwind.io"],
        cc: ["priya@acme.co"],
        subject: "Q3 pricing",
        body: "Hi Dana,\n\nShort answer: no.",
        attachments: [{ artifactId: "art-1", name: "q3.csv", mimetype: "text/csv", sizeBytes: 18432 }],
      },
      by: "agent",
      at: 1_000,
    },
    thread: [],
    updatedAt: 1_000,
  };
  const actions: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith("/api/loops/loop-inbox/items/compose-1")) return Response.json({ item });
    if (path.endsWith("/api/loops/loop-inbox/items/compose-1/action")) {
      actions.push(JSON.parse(String(init?.body)));
      item = { ...item, state: "actioned", actionKind: "send", actedAt: Date.now() };
      return Response.json({ item });
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    appState.me = { user: "owner@acme.co", org: "acme", permissions: [] };
    await vite.ssrLoadModule("/src/split.ts");
    await vite.ssrLoadModule("/src/sessions.ts");
    await vite.ssrLoadModule("/src/email-draft-card.ts");
    const { html, render } = await import("lit");
    const host = document.querySelector<HTMLElement>("#main")!;
    render(html`<email-draft-card .ref=${{ loopId: "loop-inbox", itemId: "compose-1" }}></email-draft-card>`, host);

    const until = async (ready: () => boolean, what: string): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        if (ready()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail(`timed out waiting for ${what}`);
    };
    await until(() => host.querySelector(".email-draft-body") !== null, "the draft");
    assert.equal(host.querySelector(".email-draft-body")?.textContent, "Hi Dana,\n\nShort answer: no.");
    assert.match(
      host.querySelector(".email-draft-head")?.textContent ?? "",
      /To\s*dana@northwind\.io.*Cc\s*priya@acme\.co.*Subject\s*Q3 pricing/s,
    );
    const chip = host.querySelector<HTMLAnchorElement>(".email-draft-attachments .file-chip")!;
    assert.match(chip.textContent ?? "", /q3\.csv/);
    assert.match(chip.getAttribute("href") ?? "", /\/api\/files\/art-1\/content\/q3\.csv$/);
    assert.equal(actions.length, 0, "rendering sends nothing");

    [...host.querySelectorAll<HTMLButtonElement>(".approval-btn")]
      .find((b) => /Send/.test(b.textContent ?? ""))!
      .click();
    await until(() => host.querySelector(".email-draft-meta") !== null, "the sent receipt");
    assert.deepEqual(actions, [{ kind: "send" }]);
    assert.match(host.querySelector(".email-draft-meta")?.textContent ?? "", /Sent to dana@northwind\.io/);
    assert.equal(host.querySelector(".approval-btn"), null, "a sent email offers no second send");
  } finally {
    await vite.close();
    dom.window.close();
  }
});
