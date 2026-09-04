import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const policy = readFileSync(new URL("../src/ambient-policy.ts", import.meta.url), "utf8");
const contexts = readFileSync(new URL("../src/contexts.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const sessions = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("policy edits redraw immediately and preserve focused text controls", () => {
  const markDirty = policy.match(/function markDirty\(\)[^]*?\n\}/)?.[0] ?? "";
  assert.match(markDirty, /redraw\(\)/);
  assert.match(policy, /data-focus-key="ambient-orders"/);
  assert.match(policy, /data-focus-key="ambient-bot-name"/);
  assert.match(policy, /data-focus-key=\$\{`ambient-hours-\$\{i\}`\}/);
});

test("policy controls use product language and persistent accessible labels", () => {
  for (const label of ["Ignore", "Batch updates", "Act immediately", "Treat like a person"])
    assert.match(policy, new RegExp(label));
  assert.match(policy, /<label class="ambient-field-label" for="ambient-orders">/);
  assert.match(policy, /aria-describedby="ambient-orders-hint"/);
  assert.match(policy, /describedBy: "ambient-enabled-hint"/);
  assert.match(policy, /aria-label="Bot name"/);
  assert.match(policy, /required/);
});

test("a field reads label, then control, then the prose explaining it", () => {
  for (const [id, control] of [
    ["ambient-enabled", "fieldSelect({"],
    ["ambient-orders", "<textarea"],
  ]) {
    const group = policy.match(new RegExp(`<label class="ambient-field-label" for="${id}">[^]*?</div>`))?.[0] ?? "";
    assert.ok(group, `${id} sits in its own group`);
    const controlIndex = group.indexOf(control!);
    assert.ok(controlIndex >= 0, `${id}'s control is present in its group`);
    assert.ok(controlIndex < group.indexOf(`id="${id}-hint"`), `${id}'s control comes before its hint`);
  }
});

test("both policy dropdowns come from the shared one, not hand-rolled markup", () => {
  assert.equal((policy.match(/fieldSelect\(\{/g) ?? []).length, 2);
  assert.doesNotMatch(policy, /<select/);
});

test("policy styles use the shell theme contract", () => {
  const start = css.indexOf(".ambient-policy {");
  const end = css.indexOf("\n.main {", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = css.slice(start, end);
  assert.match(block, /color: var\(--muted-foreground\)/);
  assert.match(block, /background: var\(--background\)/);
  assert.match(block, /color: var\(--foreground\)/);
  assert.doesNotMatch(block, /var\(--muted,/);
  assert.doesNotMatch(block, /var\(--panel,/);
  assert.match(block, /:focus-visible/);
  assert.match(block, /outline: 2px solid/);
});

test("the scope homepage puts work before settings and consolidates the empty project", () => {
  assert.match(contexts, /context-workspace-main[^]*?<aside class="context-settings"/);
  assert.match(contexts, /This project is ready for work/);
  assert.match(contexts, /if\s*\(\s*r\.files\.length === 0[^]*?return nothing;/);
});

test("narrow navigation overlays content and closes when its breakpoint is crossed", () => {
  assert.doesNotMatch(css, /layout:not\(\.sidebar-closed\) \.pane/);
  assert.match(shell, /narrowViewport\.addEventListener\("change"/);
  assert.match(shell, /closeSidebarOnNarrowView\(\)/);
  assert.match(css, /@container \(max-width: 760px\)[^]*?context-workspace\.has-settings/);
});

test("every sidebar destination dismisses the narrow overlay", () => {
  const openSession = sessions.match(/export async function openSession[^]*?\n\}/)?.[0] ?? "";
  const startProjectChat = sessions.match(/function startProjectChat[^]*?\n\}/)?.[0] ?? "";
  assert.match(openSession, /closeSidebarOnNarrowView\(\)/);
  assert.match(startProjectChat, /closeSidebarOnNarrowView\(\)/);
  assert.match(shell, /export function switchView[^]*?closeSidebarOnNarrowView\(\)/);
});
