import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("pasted text stages as a context card and files as typed source chips", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><div id="card"></div><div id="chip"></div>', {
    url: "http://localhost/",
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
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { render } = await import("lit");
    const { attachmentTile } = await vite.ssrLoadModule("/src/composer.ts");
    const pastedText = "Cold-chain   certification\nmust be verified before a new dairy joins the reorder workflow.";
    const paste = {
      id: "paste_1",
      type: "document",
      fileName: "pasted-text.txt",
      mimeType: "text/plain",
      size: pastedText.length,
      content: "",
      extractedText: pastedText,
    };
    const file = {
      id: "f1",
      type: "document",
      fileName: "Dairy Onboarding SOP.pdf",
      mimeType: "application/pdf",
      size: 4,
      content: "",
    };
    let opened = 0;
    let removed = 0;
    const cardHost = document.querySelector<HTMLElement>("#card")!;
    const chipHost = document.querySelector<HTMLElement>("#chip")!;
    render(
      attachmentTile(
        paste,
        true,
        () => opened++,
        () => removed++,
      ),
      cardHost,
    );
    render(
      attachmentTile(
        file,
        false,
        () => opened++,
        () => removed++,
      ),
      chipHost,
    );

    const card = cardHost.querySelector<HTMLElement>(".context-card")!;
    assert.ok(card, "a pasted attachment renders as a context card");
    assert.equal(card.querySelector(".context-card-head .chip-open span")?.textContent, "Pasted text");
    assert.equal(card.querySelector(".context-card-size")?.textContent, `${pastedText.length} characters`);
    const body = card.querySelector<HTMLElement>(".context-card-body")!;
    assert.equal(body.getAttribute("dir"), "auto");
    assert.equal(body.textContent, pastedText.replace(/\s+/g, " "));
    card.querySelector<HTMLButtonElement>(".chip-open")!.click();
    card.querySelector<HTMLButtonElement>(".chip-x")!.click();
    assert.equal(opened, 1);
    assert.equal(removed, 1);

    const chip = chipHost.querySelector<HTMLElement>(".file-chip")!;
    assert.ok(chip, "a file attachment renders as a source chip");
    assert.equal(chipHost.querySelector(".context-card"), null);
    const glyph = chip.querySelector<HTMLElement>(".file-glyph")!;
    assert.equal(glyph.dataset.ext, "pdf");
    assert.equal(glyph.textContent, "pdf");
    assert.equal(chip.querySelector('span[dir="auto"]')?.textContent, "Dairy Onboarding SOP.pdf");
    assert.equal(chip.querySelector(".chip-x")?.getAttribute("aria-label"), "Remove attachment");
  } finally {
    await vite.close();
  }
});
