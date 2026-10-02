import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
  url: "http://localhost/web-ui/",
});
Object.defineProperty(dom.window, "matchMedia", {
  value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  history: dom.window.history,
  localStorage: dom.window.localStorage,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  customElements: dom.window.customElements,
  Node: dom.window.Node,
  Event: dom.window.Event,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: clearTimeout,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
test.after(async () => {
  await vite.close();
  dom.window.close();
});
const cache = await vite.ssrLoadModule("/src/transcript-cache.ts");
const { openSessionInto } = await vite.ssrLoadModule("/src/sessions.ts");
const { mainConversation } = await vite.ssrLoadModule("/src/conversations.ts");
const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
appState.me = { user: "alex", org: "acme" };

const entry = (seq: number, type = "assistant") => ({ seq, type, payload: { text: `e${seq}` }, createdAt: seq });
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a revisit reads only the entries since the last turn and merges them into the cached page", async () => {
  const windows: unknown[] = [];
  const fetcher = async (_id: string, window?: unknown) => {
    windows.push(window);
    return windows.length === 1
      ? { entries: [entry(4, "user"), entry(5), entry(6, "user"), entry(7)], earlierEntries: 4 }
      : { entries: [entry(6, "user"), entry(7), entry(8), entry(9, "user")] };
  };
  await cache.loadTranscript("merge", { tailTurns: 25 }, fetcher);
  const merged = await cache.loadTranscript("merge", { tailTurns: 25 }, fetcher);
  assert.deepEqual(windows, [{ tailTurns: 25 }, { sinceSeq: 6 }]);
  assert.deepEqual(
    merged.entries.map((e: { seq: number }) => e.seq),
    [4, 5, 6, 7, 8, 9],
  );
  assert.equal(merged.earlierEntries, 4, "the delta keeps the cached window's history count");
  assert.equal(cache.cachedTranscript("merge"), merged);
  await cache.loadTranscript("merge", { sinceSeq: 4 }, fetcher);
  assert.deepEqual(windows.at(-1), { sinceSeq: 9 }, "a delivery refresh of the cached window is a delta too");
  await cache.loadTranscript("merge", { beforeSeq: 4, tailTurns: 25 }, fetcher);
  assert.deepEqual(windows.at(-1), { beforeSeq: 4, tailTurns: 25 }, "older pages bypass the cache");
  cache.forgetTranscript("merge");
  await cache.loadTranscript("merge", { tailTurns: 25 }, fetcher);
  assert.deepEqual(windows.at(-1), { tailTurns: 25 }, "archiving drops the cached copy");
});

test("switching keeps the old view up, shows a spinner only past 150ms, and paints a cached revisit at once", async () => {
  const reads: string[] = [];
  const delays: Record<string, number> = { "sess-fast": 20, "sess-slow": 300, "sess-other": 0, "sess-late": 300 };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://localhost");
    const id = url.pathname.split("/")[3]!;
    if (url.pathname.endsWith("/approvals")) return Response.json({ approvals: [] });
    reads.push(`${id}${url.search}`);
    await later(delays[id] ?? 0);
    return Response.json({ entries: [entry(0, "user"), entry(1)] });
  };
  const conv = mainConversation();
  const events: string[] = [];
  Object.assign(conv, {
    mountLoadingPane: () => (events.push("loading"), () => true),
    mountContinuable: (_ref: string, id: string) => {
      events.push(`mount ${id}`);
      conv.state.sessionId = id;
    },
    activePendingApprovals: () => [],
    setTranscriptWindow: () => {},
    setPins: () => {},
    onDelivery: (ref: string) => events.push(`refresh ${ref}`),
  });
  const session = (id: string) => ({ id, threadRef: `web:alex:${id}`, scopeId: "personal:alex" });

  const fast = openSessionInto(conv, session("sess-fast"), undefined, undefined, false);
  await later(10);
  assert.deepEqual(events, [], "the previous conversation stays on screen while a quick read is in flight");
  await fast;
  assert.deepEqual(events, ["loading", "mount sess-fast"], "no spinner is ever painted for a quick switch");

  events.length = 0;
  const slow = openSessionInto(conv, session("sess-slow"), undefined, undefined, false);
  await later(100);
  assert.deepEqual(events, []);
  await later(100);
  assert.deepEqual(events, ["loading"], "a slow read shows the spinner after the grace period");
  await slow;
  assert.deepEqual(events, ["loading", "loading", "mount sess-slow"]);

  await openSessionInto(conv, session("sess-other"), undefined, undefined, false);
  events.length = 0;
  const readsBefore = reads.length;
  const revisit = openSessionInto(conv, session("sess-fast"), undefined, undefined, false);
  assert.deepEqual(
    events,
    ["loading", "mount sess-fast", "refresh web:alex:sess-fast"],
    "a cached conversation paints synchronously, then refreshes in place",
  );
  await revisit;
  assert.equal(reads.length, readsBefore, "the revisit itself issues no full transcript read");

  events.length = 0;
  const abandoned = openSessionInto(conv, session("sess-late"), undefined, undefined, false);
  await openSessionInto(conv, session("sess-fast"), undefined, undefined, false);
  await abandoned;
  assert.doesNotMatch(
    events.join(),
    /mount sess-late/,
    "clicking back to the shown conversation cancels the pending switch",
  );
});
