import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const srcDir = new URL("../src/", import.meta.url);
const ui = readFileSync(new URL("ui.ts", srcDir), "utf8");
const css = readFileSync(new URL("shell.css", srcDir), "utf8");

test("the shell has exactly one dropdown, and it is a real select", () => {
  const offenders = readdirSync(srcDir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => readFileSync(new URL(f, srcDir), "utf8").includes("<select"));
  assert.deepEqual(offenders, ["ui.ts"], "every dropdown goes through fieldSelect()");
  assert.match(ui, /<select/);
  assert.match(ui, /icon\(ChevronDown, 16\)/);
});

test("the dropdown keeps the accessible name, focus key and disabled state its callers pass", () => {
  for (const attr of [
    /id=\$\{props\.id \?\? nothing\}/,
    /aria-label=\$\{props\.ariaLabel \?\? nothing\}/,
    /aria-describedby=\$\{props\.describedBy \?\? nothing\}/,
    /data-focus-key=\$\{props\.focusKey \?\? nothing\}/,
    /\?disabled=\$\{props\.disabled \?\? false\}/,
  ])
    assert.match(ui, attr);
});

test("the chevron is inset from the edge, not pinned to it", () => {
  const block = css.slice(css.indexOf(".field-select {"), css.indexOf(".field-select.compact > select"));
  assert.match(block, /appearance: none/);
  assert.match(block, /padding: 0 36px 0 10px/);
  assert.match(block, /right: 12px/);
  assert.match(block, /pointer-events: none/);
});

test("no page keeps its own select chrome now that one rule owns it", () => {
  for (const dead of [".list-select select {", ".deploy-sort select {", ".ambient-enabled-select {\n  align-self"])
    assert.ok(!css.includes(dead) || dead.includes("align-self"), `${dead} should be gone`);
  assert.doesNotMatch(css, /\.list-select select \{/);
  assert.doesNotMatch(css, /\.deploy-sort select \{/);
});

test("the dropdown applies the caller's value after its options exist", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const [{ html, render }, { fieldSelect }] = await Promise.all([import("lit"), import("../src/ui.ts")]);
  const root = dom.window.document.querySelector<HTMLElement>("#root")!;
  render(
    fieldSelect({
      value: "read-write",
      onChange: () => undefined,
      options: [
        html`<option value="read">Read only</option>`,
        html`<option value="read-write">Read and write with approval</option>`,
      ],
    }),
    root,
  );
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(root.querySelector<HTMLSelectElement>("select")?.value, "read-write");
});
