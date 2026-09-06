import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

test("approval surfaces rise once on mount and mount only while an approval is pending", () => {
  assert.match(
    css,
    /\.composer-approval-panel,\s*\.inline-approval-marker \{\s*animation: approval-rise 420ms cubic-bezier\([^)]*\) both;\s*\}/,
  );
  assert.match(
    css,
    /@keyframes approval-rise \{\s*from \{\s*opacity: 0;\s*transform: translateY\(10px\) scale\(0\.985\);/,
  );
  assert.match(composer, /approvalPauses\.length\s*\? composerApprovalPanel\(approvalPauses\)/);
  assert.doesNotMatch(composer, /class="composer-approval-panel[^"]*\$\{/);
});

test("the attention ring is a one-shot pseudo-element that fades out and never loops", () => {
  assert.match(css, /\.composer-approval-panel \{\s*position: relative;/);
  const ring = css.match(/\.composer-approval-panel::before \{[^}]*\}/)?.[0] ?? "";
  assert.match(ring, /inset: 2px;/);
  assert.match(ring, /pointer-events: none;/);
  assert.match(ring, /border: 2px solid color-mix\(in srgb, var\(--brand-accent\) 55%, transparent\);/);
  assert.match(ring, /animation: approval-ring 900ms cubic-bezier\([^)]*\) 180ms both;/);
  const frames = css.match(/@keyframes approval-ring \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(frames, /100% \{\s*opacity: 0;/);
  for (const name of ["approval-rise", "approval-ring", "badge-pop"]) {
    assert.doesNotMatch(css, new RegExp(`animation:[^;]*${name}[^;]*infinite`));
  }
});

test("the reason badge pops a beat after the card and buttons get press physics on transform only", () => {
  assert.match(css, /\.approval-reason-badge \{\s*animation: badge-pop 380ms cubic-bezier\([^)]*\) 260ms both;/);
  assert.match(css, /@keyframes badge-pop \{\s*from \{\s*opacity: 0;\s*transform: scale\(0\.6\);/);
  const btn = css.match(/\.approval-btn \{[^}]*\}/)?.[0] ?? "";
  assert.match(btn, /transition:\s*opacity 120ms ease,\s*transform 160ms cubic-bezier/);
  assert.match(css, /\.approval-btn:hover:not\(:disabled\) \{[^}]*transform: translateY\(-1px\);/);
  assert.match(css, /\.approval-btn:active:not\(:disabled\) \{\s*transform: scale\(0\.97\);/);
});

test("reduced motion drops every approval animation and transform but keeps the UI usable", () => {
  const reduce = css.match(
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.composer-approval-panel,\s*\.inline-approval-marker,\s*\.approval-reason-badge \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(reduce, "the approval reduce block must exist");
  assert.match(reduce, /\.approval-reason-badge \{\s*animation: none;/);
  assert.match(reduce, /\.composer-approval-panel::before \{\s*display: none;/);
  assert.match(reduce, /\.approval-btn \{\s*transition: none;/);
  assert.match(
    reduce,
    /\.approval-btn:hover:not\(:disabled\),\s*\.approval-btn:active:not\(:disabled\) \{\s*transform: none;/,
  );
});
