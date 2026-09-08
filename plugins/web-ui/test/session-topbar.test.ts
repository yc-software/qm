import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("the session topbar is a tab strip: ghost crumb, title pill, icon tools with count badges", async () => {
  const dom = new JSDOM('<!doctype html><div id="host"></div>', { url: "http://localhost/" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
  });
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { render } = await import("lit");
    const { sessionTopbarTpl } = (await vite.ssrLoadModule(
      "/src/session-scope.ts",
    )) as typeof import("../src/session-scope.ts");
    const host = dom.window.document.getElementById("host")!;
    const clicks: string[] = [];
    render(
      sessionTopbarTpl({
        crumb: "Acme",
        title: "Q3 plan",
        onCrumb: () => clicks.push("crumb"),
        toolCount: (tool) => (tool === "files" ? 3 : 0),
        onTool: (tool) => clicks.push(tool),
      }),
      host,
    );

    const heading = host.querySelector(".session-heading")!;
    assert.deepEqual(
      [...heading.children].map((el) => el.className),
      ["session-crumb as-link", "session-title"],
    );
    assert.equal(heading.querySelector(".session-title")!.getAttribute("dir"), "auto");

    const tools = [...host.querySelectorAll<HTMLElement>(".session-tool")];
    assert.deepEqual(
      tools.map((b) => b.getAttribute("aria-label")),
      ["Crons", "Files", "Apps", "Skills", "Memory", "Your keychain"],
    );
    assert.deepEqual(
      tools.map((b) => b.querySelector(".session-tool-count")?.textContent ?? ""),
      ["", "3", "", "", "", ""],
    );
    assert.equal(host.querySelectorAll('.session-tools-more [role="menuitem"]').length, 6);

    heading.querySelector<HTMLElement>(".session-crumb")!.click();
    tools[1]!.click();
    assert.deepEqual(clicks, ["crumb", "files"]);
  } finally {
    await vite.close();
  }
});
