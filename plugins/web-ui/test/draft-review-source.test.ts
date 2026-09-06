import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const dr = read("draft-review.ts");
const inbox = read("inbox.ts");
const main = read("main.ts");
const css = read("shell.css");

test("draft review registers as a pane kind under its own params key", () => {
  assert.match(dr, /registerPaneKind\(\{/);
  assert.match(dr, /paramsKey: "draftReview"/, "saved layouts persist the pane under draftReview");
  assert.match(main, /import "\.\/draft-review";/, "registration must run at boot");
  assert.match(inbox, /beginPaneKindDrag\("draftReview", surface\.viewId\)/, "the inbox toolbar chip starts the drag");
  assert.match(
    dr,
    /badge: \(id\) => \(can\("inbox"\) \? inboxOpenCount\(id\) : 0\)/,
    "the gated tab badge counts what needs you",
  );
});

test("the steering panel is a real conversation bound to the drafting session", () => {
  assert.match(dr, /createConversation\(\{/, "the panel is the shell's own conversation, not a mock");
  assert.match(dr, /item\.draftSessionId/, "bound to the server-stamped drafting session");
  assert.match(dr, /openSessionInto\(steer\.conversation, session\)/);
  assert.match(dr, /disposeConversation\(surface\.steer\.conversation\)/, "and released when the item changes");
  assert.doesNotMatch(
    dr,
    /message-stack|chat-scroll|user-bubble|steer-label|composer-wrap/,
    "no hand-built chat widget — the conversation renders its own form factor",
  );
});

test("a finished steer refreshes the inbox so the rewritten draft lands in place", () => {
  assert.match(dr, /if \(steer\.working && !state\.working\) void refreshInbox\(\{ silent: true \}\);/);
});

test("switching items persists the draft you were editing", () => {
  assert.match(dr, /if \(previous && previous\.id !== item\.id\) void persistDraft\(previous\);/);
});

test("source glyphs are monochrome line icons painted in currentColor", () => {
  assert.match(dr, /icon\(gmail \? Mail : Hash, 13\)/, "lucide stroke icons inherit the row's own colour");
  assert.doesNotMatch(dr, /<svg|fill="#|icon-mail\.svg|icon-slack\.svg/, "no coloured brand art");
  const glyph = css.match(/\.rv-glyph \{[^}]*\}/)?.[0] ?? "";
  assert.match(glyph, /color: var\(--muted-foreground\);/);
});

test("the mini conversation scales the shell's chat classes instead of inventing new ones", () => {
  assert.match(css, /\.mini-convo-body \.custom-chat-shell \{/);
  assert.match(css, /\.mini-convo-body \.chat-scroll \{/);
});

test("a draft review pane keeps the inbox poll alive and redraws with it", () => {
  assert.match(inbox, /export function attachInboxSurface/);
  assert.match(inbox, /\[\.\.\.externalSurfaces\]\.some\(\(s\) => s\.visible\(\)\)/);
  assert.match(dr, /attachInboxSurface\(\{/);
});
