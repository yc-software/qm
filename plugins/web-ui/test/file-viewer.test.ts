import assert from "node:assert/strict";
import { test } from "node:test";
import { createInboxFixture, until } from "./inbox-composer-fixture.ts";

test("file preview escapes CSV cells, preserves truncation warnings, copies raw text and restores focus", async () => {
  const { dom, vite, host, close } = await createInboxFixture();
  try {
    const text = `${Array.from({ length: 101 }, (_, i) => `column${i}`).join(",")}\n"<script>bad()</script>","quoted, comma"\n"unterminated`;
    globalThis.fetch = async () => new Response(text);
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (value: string) => {
          copied = value;
        },
      },
    });
    dom.window.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    dom.window.HTMLDialogElement.prototype.close = function () {
      this.open = false;
      this.dispatchEvent(new dom.window.Event("close"));
    };
    const opener = document.createElement("button");
    host.append(opener);
    opener.focus();
    const { openFileViewer } = await vite.ssrLoadModule("/src/file-viewer.ts");
    openFileViewer("export.csv", "/api/files/export/content", "csv");
    await until(() => Boolean(document.querySelector(".file-viewer-table")));
    const dialog = document.querySelector("dialog")!;
    assert.match(dialog.textContent!, /limited to 1,000 rows and 100 columns/);
    assert.match(dialog.textContent!, /CSV formatting errors/);
    assert.equal(dialog.querySelector("tr")!.children.length, 100);
    assert.equal(dialog.querySelectorAll("script").length, 0);
    assert.match(dialog.textContent!, /<script>bad\(\)<\/script>/);
    assert.match(dialog.textContent!, /quoted, comma/);
    assert.equal(dialog.querySelector("a")!.download, "export.csv");
    assert.doesNotMatch(dialog.textContent!, /Open raw|Source/);
    [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Copy")!.click();
    await until(() => copied === text);
    dialog.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')!.click();
    assert.equal(document.querySelector("dialog"), null);
    assert.equal(document.activeElement, opener);
  } finally {
    await close();
  }
});
