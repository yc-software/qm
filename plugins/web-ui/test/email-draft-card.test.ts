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
      data: {
        to: ["dana@northwind.io"],
        cc: ["priya@acme.co"],
        subject: "Q3 pricing",
        body: "Hi Dana,\n\nShort answer: **no**.",
        attachments: [{ artifactId: "art-1", name: "q3-pricing.csv", mimetype: "text/csv", sizeBytes: 18432 }],
      },
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
  let releaseEdit: (() => void) | null = null;
  const editGate = new Promise<void>((resolve) => {
    releaseEdit = resolve;
  });
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const itemPath = `/api/loops/${LOOP_ID}/items/${ITEM_ID}`;
    if (path.endsWith(itemPath)) return Response.json({ item: current });
    if (path.endsWith(`${itemPath}/action`)) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      actions.push(body);
      const args = body.args as { proposal: Record<string, unknown>; expectedProposalAt?: number };
      if (body.kind === "edit") {
        if (actions.length === 1) await editGate;
        current = entry({ proposal: { data: args.proposal, by: "human", at: 2_000 + actions.length } });
        return Response.json({ item: current });
      }
      if (body.kind === "send") {
        if (sendConflictsOnce) {
          sendConflictsOnce = false;
          current = entry({ proposal: { data: { ...args.proposal, body: "Agent redraft." }, by: "agent", at: 3_000 } });
          return Response.json(
            {
              error: "conflict",
              message: "the draft changed since you last saw it; review the new draft before sending",
            },
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
  let offChange = (): void => undefined;
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    appState.me = { user: "owner@acme.co", org: "acme", permissions: [] };
    await vite.ssrLoadModule("/src/split.ts");
    await vite.ssrLoadModule("/src/sessions.ts");
    const { emailDraftCard, onEmailDraftChange } = await vite.ssrLoadModule("/src/email-draft-card.ts");
    const { render } = await import("lit");
    const host = document.querySelector<HTMLElement>("#main")!;
    const paint = (): void => {
      render(emailDraftCard({ loopId: LOOP_ID, itemId: ITEM_ID }), host);
    };
    offChange = onEmailDraftChange(paint);
    paint();

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
    const block = host.querySelector<HTMLElement & { content?: string }>(".email-draft-body markdown-block");
    assert.ok(block, "the body previews as rendered markdown");
    assert.equal(block.content, "Hi Dana,\n\nShort answer: **no**.");
    const chip = host.querySelector<HTMLAnchorElement>(".email-draft-attachment .file-chip")!;
    assert.match(chip.textContent ?? "", /q3-pricing\.csv/);
    assert.match(chip.getAttribute("href") ?? "", /\/api\/files\/art-1\/content\/q3-pricing\.csv$/);
    assert.equal(host.querySelector(".email-draft-attachment-remove"), null, "preview has no remove control");
    assert.match(host.querySelector(".email-draft-pill")?.textContent ?? "", /Ready to send/);
    assert.match(host.querySelector(".email-draft-who")?.textContent ?? "", /owner@acme\.co/);
    assert.match(
      host.querySelector(".email-draft-recipients")?.textContent ?? "",
      /to dana@northwind\.io · cc priya@acme\.co/,
    );

    click(".email-draft-seg button", /Edit/);
    const textarea = host.querySelector<HTMLTextAreaElement>(".email-draft-textarea")!;
    assert.equal(textarea.value, "Hi Dana,\n\nShort answer: **no**.");
    assert.ok(host.querySelector(".email-draft-attachment-remove"), "edit mode can drop an attachment");
    const subject = [...host.querySelectorAll<HTMLInputElement>(".email-draft-field input")][2]!;
    subject.value = "Q3 pricing, updated";
    subject.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.match(host.querySelector(".email-draft-pill")?.textContent ?? "", /Edited/);
    subject.dispatchEvent(new dom.window.Event("blur"));
    await until(() => actions.length === 1, "the edit to be posted");
    assert.equal(actions[0]!.kind, "edit");
    assert.deepEqual(actions[0]!.args, {
      proposal: {
        to: ["dana@northwind.io"],
        cc: ["priya@acme.co"],
        subject: "Q3 pricing, updated",
        body: "Hi Dana,\n\nShort answer: **no**.",
        attachments: [{ artifactId: "art-1", name: "q3-pricing.csv", mimetype: "text/csv", sizeBytes: 18432 }],
      },
      expectedProposalAt: 1_000,
    });
    assert.ok(host.querySelector(".email-draft-send:not([disabled])"), "a save in flight never disables Send");
    textarea.value = "Hi Dana,\n\nShort answer: **no**. Typed mid-save.";
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    releaseEdit!();
    await until(() => host.querySelector(".email-draft-pill")?.textContent?.includes("Edited") === true, "the pill");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      host.querySelector<HTMLTextAreaElement>(".email-draft-textarea")?.value,
      "Hi Dana,\n\nShort answer: **no**. Typed mid-save.",
      "text typed while a save was in flight survives the save landing",
    );
    click(".email-draft-attachment-remove");
    await until(() => actions.length === 2, "the attachment removal to persist");
    assert.equal((actions[1]!.args as { proposal: { attachments?: unknown } }).proposal.attachments, undefined);
    assert.equal(host.querySelector(".email-draft-attachment"), null, "the chip is gone once removed");

    textarea.dispatchEvent(new dom.window.Event("blur"));
    click(".email-draft-send");
    const sendEnabled = (): boolean => host.querySelector(".email-draft-send:not([disabled])") !== null;
    await until(() => host.querySelector(".email-draft-notice") !== null && sendEnabled(), "the conflict notice");
    assert.deepEqual(
      actions.map((a) => a.kind),
      ["edit", "edit", "send"],
      "a Send clicked while the blur save is pending waits for it instead of being dropped",
    );
    assert.equal(
      (actions[1]!.args as { proposal: { body: string } }).proposal.body,
      "Hi Dana,\n\nShort answer: **no**. Typed mid-save.",
    );
    assert.equal((actions[2]!.args as { expectedProposalAt: number }).expectedProposalAt, 2_002);
    assert.match(
      host.querySelector(".email-draft-notice")?.textContent ?? "",
      /changed this draft while you were looking/,
    );
    assert.equal(host.querySelector<HTMLTextAreaElement>(".email-draft-textarea")?.value, "Agent redraft.");

    click(".email-draft-send");
    await until(() => host.querySelector(".email-draft-receipt") !== null, "the sent receipt");
    assert.equal((actions[3]!.args as { expectedProposalAt: number }).expectedProposalAt, 3_000);
    assert.match(
      host.querySelector(".email-draft-receipt")?.textContent ?? "",
      /Sent.*Q3 pricing, updated.*dana@northwind\.io/,
    );
    assert.equal(host.querySelector(".email-draft-send"), null, "a sent email offers no second send");
  } finally {
    offChange();
    await vite.close();
    dom.window.close();
  }
});
