import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
const coreBridge = readFileSync(new URL("../src/core-bridge.ts", import.meta.url), "utf8");
const conversations = readFileSync(new URL("../src/conversations.ts", import.meta.url), "utf8");
const inbox = readFileSync(new URL("../src/inbox.ts", import.meta.url), "utf8");

test("the BFF sends each loop-item change only to its viewers and resyncs everyone only on reconnect", () => {
  const feed = server.match(/function runInboxFeed\(\): Promise<void> \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(feed, /consumeCoreFeed\(\s*"\/v1\/loop-items\/events",\s*"loop_item",/);
  assert.match(feed, /forwardInboxItem\([\s\S]*?\),\s*resyncInbox,/);
  const forward = server.match(/async function forwardInboxItem\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(
    forward,
    /"\/v1\/inbox\/viewers",\s*JSON\.stringify\(\{ loopId: ev\.loopId, candidates: \[\.\.\.deliveryClients\.keys\(\)\] \}\)/,
  );
  assert.match(
    forward,
    /for \(const user of viewers\) for \(const res of deliveryClients\.get\(user\) \?\? \[\]\) sseEvent\(res, "inbox_item", frame\);/,
  );
  assert.match(
    forward,
    /if \(!viewers\) return resyncInbox\(\);/,
    "an unanswerable viewer lookup falls back to a resync, so nobody misses a change",
  );
  assert.doesNotMatch(forward, /inbox_resync/);
});

test("the BFF treats a core-side resync frame like a dropped feed", () => {
  const consume = server.match(/async function consumeCoreFeed\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(consume, /event: \$\{eventName\}_resync`\)\) \{\s*onReconnect\?\.\(\);\s*continue;/);
});

test("a resync or item event while the inbox is hidden marks it stale, and the next staleness-gated refresh consumes the mark", () => {
  const gate = inbox.match(/async function refreshWhenVisible[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(gate, /resyncMissedWhileHidden = true;\s*return;\s*\}\s*await refreshInbox\(\{ silent: true \}\);/);
  const refresh = inbox.match(/export async function refreshInbox[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(
    refresh,
    /if \(opts\.ifStaleMs !== undefined && !resyncMissedWhileHidden && Date\.now\(\) - inboxState\.fetchedAt < opts\.ifStaleMs\)\s*return;\s*resyncMissedWhileHidden = false;/,
    "every ifStaleMs caller honors the mark, and it clears only when a fetch actually starts",
  );
  const realtime = inbox.match(/function ensureRealtime\(\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(
    realtime,
    /addEventListener\("visibilitychange"[\s\S]*?refreshInbox\(\{ ifStaleMs: 30_000, silent: true \}\)/,
  );
});

test("the browser handles inbox_resync frames and treats its own reconnect the same way", () => {
  assert.match(coreBridge, /es\.addEventListener\("inbox_resync", \(\) => onInboxResync\?\.\(\)\);/);
  const onopen = coreBridge.match(/es\.onopen = [\s\S]*?everOpened = true;/)?.[0] ?? "";
  assert.match(onopen, /onResync\?\.\(\);/);
  assert.match(onopen, /onInboxResync\?\.\(\);/, "an EventSource reopen resyncs the inbox, not just the session list");
});

test("a resync lands as a silent inbox refresh", () => {
  assert.match(conversations, /\(\) => inboxResyncHandler\?\.\(\)/);
  const wired = inbox.match(/onInboxResync\(\(\) => \{[\s\S]*?\}\);/)?.[0] ?? "";
  assert.match(wired, /void refreshWhenVisible\(\);/);
});

test("realtime inbox events flow through the coalescer, so a burst refetches every touched item", () => {
  assert.match(inbox, /enqueueRealtimeEvent\(\{ loopId: event\.loopId, itemId: event\.itemId \}\);/);
  assert.match(
    inbox,
    /if \(inboxState\.loaded && !inboxState\.selected\.some\(\(loop\) => loop\.id === event\.loopId\)\) return;/,
    "an event that lands before the first load finishes still queues a follow-up refresh",
  );
  assert.match(inbox, /createInboxEventCoalescer\(\s*250,\s*\(\) => void refreshWhenVisible\(\),/);
});

test("a refresh requested while one is in flight re-runs instead of being dropped", () => {
  const refresh = inbox.match(/export async function refreshInbox[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(
    refresh,
    /if \(inboxState\.loading\) \{\s*if \(opts\.ifStaleMs === undefined \|\| resyncMissedWhileHidden\) refreshFollowUp = true;/,
  );
  assert.match(
    refresh,
    /if \(refreshFollowUp\) \{\s*refreshFollowUp = false;\s*void refreshInbox\(\{ silent: true \}\);/,
  );
});
