import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { browserEnv } from "./browser-env.ts";
import type { TranscriptPage } from "../src/core-bridge.ts";

const entry = (seq: number, text: string) => ({
  seq,
  type: seq % 2 ? "assistant" : "user",
  createdAt: 1_700_000_000_000 + seq,
  payload: { text },
});
const page = (...seqs: number[]): TranscriptPage =>
  ({ entries: seqs.map((seq) => entry(seq, `message ${seq}`)) }) as TranscriptPage;

const pin = (id: string) => ({ id, addedBy: "tester", createdAt: 1 });

const TAIL = 6;
const transcripts = new Map<string, ReturnType<typeof entry>[]>();
const approvals = new Map<string, Array<{ requestId: string; command: string; reason: string }>>();
const requests: string[] = [];
const failing = new Set<string>();
const env = await browserEnv({
  fetch: async (input) => {
    const url = new URL(String(input), "http://localhost");
    const path = `${url.pathname}${url.search}`;
    requests.push(path);
    if (failing.has(path)) return Response.json({ error: "boom" }, { status: 500 });
    if (url.pathname === "/api/runtime-config")
      return Response.json({
        scopeId: "personal:tester",
        approvedHarnesses: [],
        modelsByHarness: {},
        modelCatalog: {},
        effective: { harnessId: "pi", modelId: "m" },
      });
    const approvalsFor = url.pathname.match(/^\/api\/sessions\/([^/]+)\/approvals$/)?.[1];
    if (approvalsFor) return Response.json({ approvals: approvals.get(decodeURIComponent(approvalsFor)) ?? [] });
    if (url.pathname === "/api/sessions")
      return Response.json({ sessions: [...transcripts.keys()].map((id) => session(id)) });
    const id = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)?.[1];
    if (id) {
      const all = transcripts.get(decodeURIComponent(id)) ?? [];
      const since = Number(url.searchParams.get("sinceSeq") ?? 0);
      const entries = all.filter((e) => e.seq >= since).slice(-TAIL);
      return Response.json({ entries, earlierEntries: all.length - entries.length });
    }
    return Response.json({ contexts: [], items: [], crons: [] });
  },
});
after(env.close);

let cache: Record<string, any>;
let sessions: Record<string, any>;
let shell: Record<string, any>;
let conversations: Record<string, any>;

beforeEach(async () => {
  document.body.innerHTML = '<div id="app"></div><main></main>';
  env.dom.window.history.replaceState(null, "", "/");
  env.vite.moduleGraph.invalidateAll();
  shell = await env.vite.ssrLoadModule("/src/shell.ts");
  sessions = await env.vite.ssrLoadModule("/src/sessions.ts");
  cache = await env.vite.ssrLoadModule("/src/transcript-cache.ts");
  conversations = await env.vite.ssrLoadModule("/src/conversations.ts");
  shell.appState.me = { user: "tester", org: "test" };
  shell.appState.currentView = "chats";
  shell.appState.mainEl = document.querySelector("main");
  requests.length = 0;
  transcripts.clear();
  approvals.clear();
  failing.clear();
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
function session(id: string, canContinue = true) {
  return {
    id,
    threadRef: `web:tester:${id}`,
    scopeId: "personal:tester",
    title: `Title ${id}`,
    canContinue,
  };
}
const mounted = () =>
  JSON.stringify(
    conversations.allConversations().find((conv: any) => conv.state.host?.isConnected)?.state.agent?.state.messages ??
      [],
  );

test("the cache evicts the least recently used session past its capacity", () => {
  cache.storeTranscript("a", page(0));
  for (let i = 1; i <= 200; i++) {
    cache.storeTranscript(`f${i}`, page(i));
    assert.ok(cache.cachedTranscript("a"), "a read refreshes recency");
  }
  assert.equal(cache.cachedTranscript("f1"), undefined, "the cache is bounded");
  for (let i = 201; i <= 400; i++) cache.storeTranscript(`f${i}`, page(i));
  assert.equal(cache.cachedTranscript("a"), undefined, "an unread entry ages out");
});

test("a page changes when it brings a new entry, pins, goal or runtime", () => {
  const base = { ...page(1, 2, 3), pins: [pin("p")] } as TranscriptPage;
  assert.equal(cache.transcriptChanged(base, { ...page(1, 2, 3), pins: [pin("p")] } as TranscriptPage), false);
  assert.equal(cache.transcriptChanged(base, page(2, 3)), true, "pins dropped");
  assert.equal(cache.transcriptChanged({ ...page(1, 2, 3) } as TranscriptPage, page(2, 3)), false, "a trimmed tail");
  assert.equal(cache.transcriptChanged(base, { ...page(2, 3, 4), pins: [pin("p")] } as TranscriptPage), true);
  assert.equal(
    cache.transcriptChanged(base, { ...page(1, 2, 3), pins: [pin("p")], goal: { objective: "x" } } as TranscriptPage),
    true,
  );
});

async function visitThenLeave(id: string, canContinue = true) {
  transcripts.set("other", [entry(0, "other chat")]);
  await sessions.openSession(session(id, canContinue));
  await sessions.openSession(session("other"));
  await settle();
  requests.length = 0;
}

test("revisiting a session mounts from cache at once, then refreshes the tail in the background", async () => {
  transcripts.set("a", [entry(0, "first question"), entry(1, "first answer")]);
  await visitThenLeave("a");
  transcripts.get("a")!.push(entry(2, "follow up question"), entry(3, "fresh answer"));

  const opening = sessions.openSession(session("a"));
  assert.equal(document.querySelector(".chat-loading"), null, "no loading pane on a cache hit");
  assert.match(mounted(), /first answer/);
  assert.doesNotMatch(mounted(), /fresh answer/);
  await opening;
  await settle();

  assert.deepEqual(
    requests.filter((path) => path.startsWith("/api/sessions/a?")),
    ["/api/sessions/a?tailTurns=25"],
  );
  assert.match(mounted(), /fresh answer/);
  assert.match(mounted(), /first answer/);
  assert.deepEqual(
    cache.cachedTranscript("a").entries.map((e: { seq: number }) => e.seq),
    [0, 1, 2, 3],
  );
});

test("an unchanged session is not redrawn and keeps its cached page", async () => {
  transcripts.set("a", [entry(0, "first question"), entry(1, "first answer")]);
  await visitThenLeave("a");
  const before = cache.cachedTranscript("a");
  await sessions.openSession(session("a"));
  await settle();
  assert.equal(cache.cachedTranscript("a"), before);
  assert.match(mounted(), /first answer/);
});

test("a pending approval lands on the refreshed transcript of a revisited chat", async () => {
  transcripts.set("a", [entry(0, "first question"), entry(1, "first answer")]);
  await visitThenLeave("a");
  transcripts.get("a")!.push(entry(2, "run it"), entry(3, "running"));
  approvals.set("a", [{ requestId: "ap1", command: "rm -rf build", reason: "needs approval" }]);

  await sessions.openSession(session("a"));
  await settle();
  await settle();

  assert.match(mounted(), /running/);
  assert.equal(mounted().split("ap1").length - 1, 1, "attached exactly once");
});

test("a read-only session mounts from cache and remounts with the refreshed tail", async () => {
  transcripts.set(
    "ro",
    Array.from({ length: 10 }, (_, i) => entry(i, `archived ${i}`)),
  );
  await visitThenLeave("ro", false);
  transcripts.get("ro")!.push(entry(10, "late arrival"));

  const opening = sessions.openSession(session("ro", false));
  assert.equal(document.querySelector(".chat-loading"), null);
  assert.ok(document.querySelector(".readonly-chat"));
  await opening;
  await settle();
  assert.match(document.body.textContent ?? "", /late arrival/);
  assert.equal(cache.cachedTranscript("ro").entries.length, TAIL, "the cache holds the server's tail window");
});

test("a failed refresh keeps the cached view and drops the cache entry", async () => {
  transcripts.set("a", [entry(0, "first question"), entry(1, "first answer")]);
  await visitThenLeave("a");
  failing.add("/api/sessions/a?tailTurns=25");

  await sessions.openSession(session("a"));
  assert.match(mounted(), /first answer/);
  await settle();

  assert.match(mounted(), /first answer/);
  assert.equal(cache.cachedTranscript("a"), undefined, "retry opens cold");
});

test("signing out clears the cache", async () => {
  transcripts.set("a", [entry(0, "first question"), entry(1, "first answer")]);
  await visitThenLeave("a");
  assert.ok(cache.cachedTranscript("a"));
  shell.renderAuthGate({ kind: "portal" });
  assert.equal(cache.cachedTranscript("a"), undefined);
});
