import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { browserEnv } from "./browser-env.ts";

const entry = (seq: number, text: string) => ({
  seq,
  type: seq % 2 ? "assistant" : "user",
  createdAt: 1_700_000_000_000 + seq,
  payload: { text },
});

const TAIL = 6;
const transcripts = new Map<string, ReturnType<typeof entry>[]>();
const workingThreads = new Set<string>();
let activeRunBody: Record<string, unknown> = {};
let activeRunGate: Promise<void> | null = null;
let openActiveRunGate: (() => void) | null = null;

function holdActiveRun(): void {
  activeRunGate = new Promise<void>((resolve) => {
    openActiveRunGate = resolve;
  });
}

function answerActiveRun(): void {
  openActiveRunGate?.();
  abandonActiveRun();
}

function abandonActiveRun(): void {
  activeRunGate = null;
  openActiveRunGate = null;
}

const env = await browserEnv({
  fetch: async (input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/runtime-config")
      return Response.json({
        scopeId: "personal:tester",
        approvedHarnesses: [],
        modelsByHarness: {},
        modelCatalog: {},
        effective: { harnessId: "pi", modelId: "m" },
      });
    if (url.pathname === "/api/runs/active") {
      if (activeRunGate) await activeRunGate;
      return Response.json({ queued: [], ...activeRunBody });
    }
    const approvalsFor = url.pathname.match(/^\/api\/sessions\/([^/]+)\/approvals$/)?.[1];
    if (approvalsFor) return Response.json({ approvals: [] });
    if (url.pathname === "/api/sessions")
      return Response.json({ sessions: [...transcripts.keys()].map((id) => session(id)) });
    const id = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)?.[1];
    if (id) {
      const all = transcripts.get(decodeURIComponent(id)) ?? [];
      const entries = all.slice(-TAIL);
      return Response.json({ entries, earlierEntries: all.length - entries.length });
    }
    return Response.json({ contexts: [], items: [], crons: [] });
  },
});
after(env.close);

let sessions: Record<string, any>;
let shell: Record<string, any>;
let conversations: Record<string, any>;

beforeEach(async () => {
  document.body.innerHTML = '<div id="app"></div><main></main>';
  env.dom.window.history.replaceState(null, "", "/");
  env.vite.moduleGraph.invalidateAll();
  shell = await env.vite.ssrLoadModule("/src/shell.ts");
  sessions = await env.vite.ssrLoadModule("/src/sessions.ts");
  conversations = await env.vite.ssrLoadModule("/src/conversations.ts");
  shell.appState.me = { user: "tester", org: "test" };
  shell.appState.currentView = "chats";
  shell.appState.mainEl = document.querySelector("main");
  transcripts.clear();
  workingThreads.clear();
  activeRunBody = {};
  abandonActiveRun();
});

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function session(id: string) {
  const threadRef = `web:tester:${id}`;
  return {
    id,
    threadRef,
    scopeId: "personal:tester",
    title: `Title ${id}`,
    canContinue: true,
    ...(workingThreads.has(threadRef) ? { working: true } : {}),
  };
}

async function visitThenLeave(id: string) {
  transcripts.set("other", [entry(0, "other chat")]);
  await sessions.openSession(session(id));
  await sessions.openSession(session("other"));
  await settle();
}

const workLine = () =>
  (document.querySelector("main [aria-live='polite'].live-work-status")?.textContent ?? "").replace(/\s+/g, " ").trim();
const mounted = () =>
  JSON.stringify(
    conversations.allConversations().find((conv: any) => conv.state.host?.isConnected)?.state.agent?.state.messages ??
      [],
  );

test("switching into a session with a live turn says it is thinking before the run lookup answers", async () => {
  transcripts.set("a", [entry(0, "run the build"), entry(1, "starting")]);
  await visitThenLeave("a");
  workingThreads.add("web:tester:a");
  activeRunBody = { runId: "run-1", run: { status: "running", result: null } };
  holdActiveRun();

  const opening = sessions.openSession(session("a"));
  assert.match(mounted(), /starting/, "the cached transcript paints at once");
  assert.match(workLine(), /Thinking/, "the work line paints with the cached transcript");

  await opening;
  await settle();
  assert.match(workLine(), /Thinking/, "the background transcript reconcile keeps the work line");
});

test("an idle session never borrows a work line", async () => {
  transcripts.set("b", [entry(0, "question"), entry(1, "answer")]);
  await visitThenLeave("b");

  const opening = sessions.openSession(session("b"));
  assert.equal(workLine(), "");
  await opening;
  await settle();
  assert.equal(workLine(), "");
});

test("a turn that ended between the list refresh and the click takes its work line back down", async () => {
  transcripts.set("c", [entry(0, "question"), entry(1, "answer")]);
  await visitThenLeave("c");
  workingThreads.add("web:tester:c");
  holdActiveRun();

  const opening = sessions.openSession(session("c"));
  assert.match(workLine(), /Thinking/, "the session row still said running");

  answerActiveRun();
  await opening;
  await settle();
  assert.equal(workLine(), "", "the lookup found nothing live");
});

test("a cold open of a running session shows the work line with its first paint", async () => {
  transcripts.set("d", [entry(0, "question"), entry(1, "answer")]);
  workingThreads.add("web:tester:d");
  activeRunBody = { runId: "run-2", run: { status: "running", result: null } };
  holdActiveRun();

  await sessions.openSession(session("d"));
  assert.match(mounted(), /answer/);
  assert.match(workLine(), /Thinking/);
});
