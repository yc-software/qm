import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("approval details use the full row above their actions", () => {
  const approval = css.match(/\.composer-approval \{[^}]*\}/)?.[0] ?? "";
  const copy = css.match(/\.composer-approval-copy \{[^}]*\}/)?.[0] ?? "";
  const actions = css.match(/\.composer-approval \.approval-actions \{[^}]*\}/)?.[0] ?? "";

  assert.match(approval, /display: flex;/);
  assert.match(approval, /flex-direction: column;/, "actions belong below the approval details at every width");
  assert.match(copy, /width: 100%;/, "approval details should use the full available row");
  assert.match(actions, /width: 100%;/, "the action row should not compete with the details for width");
});

test("phone approval actions use full-width touch targets", () => {
  const phone = css.match(/@media \(max-width: 560px\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  const button = phone.match(/\.composer-approval \.approval-btn \{[^}]*\}/)?.[0] ?? "";

  assert.match(button, /width: 100%;/);
  assert.match(button, /min-height: 44px;/);
});

test("approval panel caps to the pane viewport and scrolls instead of clipping", () => {
  const panel = css.match(/\.composer-approval-panel \{[^}]*\}/)?.[0] ?? "";
  assert.match(panel, /max-height: calc\(100dvh - \d+px\);/, "panel needs a viewport-relative height cap");
  assert.match(panel, /overflow-y: auto;/, "panel must scroll once the cap binds");
});

test("pane glance renders no placeholder text for an empty chat", () => {
  assert.ok(!chat.includes("No messages yet"), "the No-messages-yet placeholder is gone");
  const glance = chat.slice(chat.indexOf("function paneGlance"), chat.indexOf("function paneNowLine"));
  assert.match(glance, /\$\{now \?\? snippet\}/, "strip falls back to the snippet alone");
  assert.match(
    glance,
    /\$\{snippet \? html`<div class="pane-card-last">\$\{snippet\}<\/div>` : nothing\}/,
    "card omits the last-reply row when empty",
  );
});
