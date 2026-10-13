import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import type { TemplateResult } from "lit";

test("fieldSelect restores its value after mounting and replacing options", async () => {
  const dom = new JSDOM("<!doctype html><main></main>");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  try {
    const { html, nothing, render } = await import("lit");
    const { live } = await import("lit/directives/live.js");
    const { ref } = await import("lit/directives/ref.js");
    const source = readFileSync(new URL("../src/ui.ts", import.meta.url), "utf8");
    const start = source.indexOf("export function fieldSelect(");
    const end = source.indexOf("export interface MenuSelectOption", start);
    const fieldSelect = runInNewContext(
      stripTypeScriptTypes(source.slice(start, end).replace("export ", "")) + "\nfieldSelect",
      { html, nothing, live, ref, queueMicrotask, icon: () => nothing, ChevronDown: null },
    ) as (props: { value?: string; options: TemplateResult[]; onChange: (value: string) => void }) => TemplateResult;
    const host = dom.window.document.querySelector("main")!;
    let changed = "";
    const draw = (value?: string, options = ["context", "none"]) =>
      render(
        fieldSelect({
          value,
          options: options.map((option) => html`<option value=${option}>${option}</option>`),
          onChange: (v) => {
            changed = v;
          },
        }),
        host,
      );
    draw("none");
    await Promise.resolve();
    assert.equal(host.querySelector("select")!.value, "none");
    render(nothing, host);
    draw("none");
    await Promise.resolve();
    assert.equal(host.querySelector("select")!.value, "none");
    draw("personal", ["org", "personal"]);
    await Promise.resolve();
    assert.equal(host.querySelector("select")!.value, "personal");
    draw("org", ["org", "personal"]);
    draw("personal", ["org", "personal"]);
    await Promise.resolve();
    const select = host.querySelector("select")!;
    assert.equal(select.value, "personal");
    select.value = "org";
    select.dispatchEvent(new dom.window.Event("change"));
    assert.equal(changed, "org");
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
    dom.window.close();
  }
});
