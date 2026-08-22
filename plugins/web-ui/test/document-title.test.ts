import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatWebDocumentTitle } from "../src/document-title.ts";

test("default tab title matches the static shell branding", () => {
  assert.equal(formatWebDocumentTitle("QM", null), "QM · Web");
  assert.equal(formatWebDocumentTitle("  ", undefined), "QM · Web");
});

test("an open conversation uses its title with the brand suffix", () => {
  assert.equal(formatWebDocumentTitle("QM", "Choose assistant tone"), "Choose assistant tone · QM");
  assert.equal(formatWebDocumentTitle("straylight", "Weekly digest"), "Weekly digest · straylight");
});

test("untitled and whitespace-only titles fall back to the brand default", () => {
  assert.equal(formatWebDocumentTitle("QM", ""), "QM · Web");
  assert.equal(formatWebDocumentTitle("QM", "   "), "QM · Web");
});

test("brand label is trimmed and empty brand falls back to QM", () => {
  assert.equal(formatWebDocumentTitle("  Acme  ", "Hello"), "Hello · Acme");
  assert.equal(formatWebDocumentTitle("", "Hello"), "Hello · QM");
});

test("document title syncs from url state, session list redraws, and split focus changes", () => {
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
  const sessions = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");
  const split = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");
  assert.match(shell, /syncDocumentTitle\(\);/);
  assert.match(shell, /export function syncDocumentTitle/);
  assert.match(sessions, /syncDocumentTitle\(\);/);
  assert.match(split, /onDidActivePanelChange[\s\S]*syncDocumentTitle\(\)/);
  assert.match(split, /export function focusedPaneConversationTitle/);
});
