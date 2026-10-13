import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import type { TemplateResult } from "lit";
import { restoreDialogFocus } from "../src/dialog-focus.ts";

test("context groups start closed, preserve expansion by identity, and reveal search results", async () => {
  const dom = new JSDOM("<!doctype html><main></main>");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  try {
    const { html, nothing, render } = await import("lit");
    const { repeat } = await import("lit/directives/repeat.js");
    const source = readFileSync(new URL("../src/list-page.ts", import.meta.url), "utf8");
    const { listGroupsTpl } = runInNewContext(
      stripTypeScriptTypes(source.replace(/^import .*;\n/gm, "").replace(/^export /gm, "")) + "\n({ listGroupsTpl })",
      { html, nothing, repeat, relTime: String },
    ) as { listGroupsTpl: (groups: unknown[], searching?: boolean) => TemplateResult };
    const groups = ["Personal", "Project"].map((label) => ({
      key: label,
      label,
      latest: 1,
      rows: [html`<a>${label} item</a>`],
    }));
    const host = dom.window.document.querySelector("main")!;
    const draw = (items = groups, searching = false) => render(listGroupsTpl(items, searching), host);
    draw();
    assert.ok([...host.querySelectorAll("details")].every((group) => !group.open));
    host.querySelector("summary")!.click();
    assert.equal(host.querySelector("details")!.open, true);
    draw([...groups].reverse());
    assert.equal(host.querySelectorAll("details")[1]!.open, true);
    assert.equal(host.querySelectorAll("details")[0]!.open, false);
    draw(groups, true);
    assert.ok([...host.querySelectorAll("details")].every((group) => group.open));
    draw();
    assert.ok([...host.querySelectorAll("details")].every((group) => !group.open));
    const skillSource = readFileSync(new URL("../src/skills.ts", import.meta.url), "utf8");
    const start = skillSource.indexOf("function restoreFocusedFlow(");
    const end = skillSource.indexOf("function closeFocusedFlow(", start);
    const restore = runInNewContext(stripTypeScriptTypes(skillSource.slice(start, end)) + "\nrestoreFocusedFlow", {
      queueMicrotask,
      creating: null,
      editingTarget: null,
      archiveConfirmation: null,
      appState: { currentView: "skills" },
      skillsPageHost: host,
      restoreDialogFocus,
    }) as (target: HTMLElement) => void;
    const row = host.querySelector("a")!;
    row.className = "skill-row";
    row.dataset.skillId = "skill-id";
    row.href = "#skill";
    const opener = dom.window.document.createElement("button");
    opener.dataset.skillId = "skill-id";
    restore(opener);
    await Promise.resolve();
    assert.equal(host.querySelector("details")!.open, true);
    assert.equal(dom.window.document.activeElement, row);
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
    dom.window.close();
  }
});
