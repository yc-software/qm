import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const LOOP_ID = "loop-inbox";
const ITEM_ID = "compose-1";

function entry(over: Record<string, unknown> = {}, proposalAt = 1_000): Record<string, unknown> {
  return {
    id: ITEM_ID,
    loopId: LOOP_ID,
    dedupeKey: "compose:abc",
    state: "held",
    source: "gmail",
    sourcePayload: { source: "gmail", compose: true, title: "Q3 pricing", from: "owner@acme.co", snippet: "Hi Dana" },
    sourceAt: 1_000,
    proposal: {
      data: { to: ["dana@northwind.io"], cc: ["priya@acme.co"], subject: "Q3 pricing", body: "Hi Dana,\n\nShort answer: no." },
      by: "agent",
      at: proposalAt,
      sessionId: "s1",
    },
    thread: [],
    updatedAt: 1_000,
    ...over,
  };
}

test("the email draft card previews, edits, and sends through the ledger with revision checks", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
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

  let current = entry();
  const actions: Array<Record<string, unknown>> = [];
  let sendConflictsOnce = true;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const itemPath = `/api/loops/${LOOP_ID}/items/${ITEM_ID}`;
    if (path.endsWith(itemPath)) return Response.json({ item: current });
    if (path.endsWith(`${itemPath}/action`)) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      actions.push(body);
      const args = body.args as { proposal: Record<string, unknown>; expectedProposalAt?: number };
      if (body.kind === "edit") {
        current = entry({ proposal: { data: args.proposal, by: "human", at: 2_000 } }, 2_000);
        return Response.json({ item: current });
      }
      if (body.kind === "send") {
        if (sendConflictsOnce) {
          sendConflictsOnce = false;
          current = entry({ proposal: { data: { ...args.proposal, body: "Agent redraft." }, by: "agent", at: 3_000 } });
          return Response.json(
            { error: "conflict", message: "the draft changed since you last saw it; review the new draft before sending" },
            { status: 409 },
          );
        }
        current = entry({ state: "actioned", actionKind: "send", actedAt: Date.now(), proposal: current.proposal });
        return Response.json({ item: current });
      }
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    appState.me = { user: "owner@acme.co", org: "acme", permissions: [] };
    await vite.ssrLoadModule("/src/split.ts");
    await vite.ssrLoadModule("/src/sessions.ts");
    const { emailDraftCard } = await vite.ssrLoadModule("/src/email-draft-card.ts");
    const host = emailDraftCard({ loopId: LOOP_ID, itemId: ITEM_ID }) as HTMLElement;
    document.querySelector("#main")!.append(host);

    const until = async (ready: () => boolean, what: string): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        if (ready()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail(`timed out waiting for ${what}`);
    };
    const click = (selector: string, text?: RegExp): void => {
      const button = [...host.querySelectorAll<HTMLButtonElement>(selector)].find(
        (b) => !text || text.test(b.textContent ?? ""),
      );
      assert.ok(button, `no button ${selector} ${text ?? ""}`);
      button.click();
    };

    await until(() => host.querySelector(".email-draft-subject") !== null, "the preview");
    assert.equal(host.querySelector(".email-draft-subject")?.textContent, "Q3 pricing");
    assert.equal(host.querySelectorAll(".email-draft-body p").length, 2, "paragraphs split on blank lines");
    assert.match(host.querySelector(".email-draft-pill")?.textContent ?? "", /Ready to send/);
    assert.match(host.querySelector(".email-draft-who")?.textContent ?? "", /owner@acme\.co/);
    assert.match(host.querySelector(".email-draft-recipients")?.textContent ?? "", /to dana@northwind\.io · cc priya@acme\.co/);

    click(".email-draft-seg button", /Edit/);
    const textarea = host.querySelector<HTMLTextAreaElement>(".email-draft-textarea")!;
    assert.equal(textarea.value, "Hi Dana,\n\nShort answer: no.");
    const subject = [...host.querySelectorAll<HTMLInputElement>(".email-draft-field input")][2]!;
    subject.value = "Q3 pricing, updated";
    subject.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.match(host.querySelector(".email-draft-pill")?.textContent ?? "", /Edited/);
    subject.dispatchEvent(new dom.window.Event("blur"));
    const sendEnabled = (): boolean => host.querySelector(".email-draft-send:not([disabled])") !== null;
    await until(() => actions.length === 1 && sendEnabled(), "the edit to persist");
    assert.equal(actions[0]!.kind, "edit");
    assert.deepEqual(actions[0]!.args, {
      proposal: {
        to: ["dana@northwind.io"],
        cc: ["priya@acme.co"],
        subject: "Q3 pricing, updated",
        body: "Hi Dana,\n\nShort answer: no.",
      },
      expectedProposalAt: 1_000,
    });

    click(".email-draft-send");
    await until(() => host.querySelector(".email-draft-notice") !== null && sendEnabled(), "the conflict notice");
    assert.equal(actions[1]!.kind, "send");
    assert.equal((actions[1]!.args as { expectedProposalAt: number }).expectedProposalAt, 2_000);
    assert.match(host.querySelector(".email-draft-notice")?.textContent ?? "", /agent changed this draft/);
    assert.equal(host.querySelector<HTMLTextAreaElement>(".email-draft-textarea")?.value, "Agent redraft.");

    click(".email-draft-send");
    await until(() => host.querySelector(".email-draft-receipt") !== null, "the sent receipt");
    assert.equal((actions[2]!.args as { expectedProposalAt: number }).expectedProposalAt, 3_000);
    assert.match(host.querySelector(".email-draft-receipt")?.textContent ?? "", /Sent.*Q3 pricing, updated.*dana@northwind\.io/);
    assert.equal(host.querySelector(".email-draft-send"), null, "a sent email offers no second send");
  } finally {
    await vite.close();
    dom.window.close();
  }
});
