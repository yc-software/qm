import assert from "node:assert/strict";
import { test } from "node:test";
import { createInboxFixture } from "./inbox-composer-fixture.ts";

test("an HTML attachment previews in a sandboxed frame and stays folded once the reader folds it", async () => {
  const { dom, vite, host, close } = await createInboxFixture();
  try {
    const { render } = await vite.ssrLoadModule("lit");
    const { htmlPreviewCard } = await vite.ssrLoadModule("/src/html-preview.ts");
    const href = "/api/files/a1/content/report.html";
    const mount = (): HTMLDetailsElement => {
      render(null, host);
      render(htmlPreviewCard("report.html", href, 2048, href), host);
      return host.querySelector("details")!;
    };
    const card = mount();
    const frame = card.querySelector("iframe")!;
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
    assert.equal(frame.getAttribute("src"), href);
    assert.equal(card.querySelector(".file-html-title")!.textContent, "report.html2 KB");
    assert.equal(card.querySelector<HTMLAnchorElement>("a[download]")!.download, "report.html");
    assert.equal(card.open, true);
    card.open = false;
    card.dispatchEvent(new dom.window.Event("toggle"));
    assert.equal(mount().open, false);
  } finally {
    await close();
  }
});
