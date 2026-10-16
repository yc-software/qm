import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { browserEnv } from "./browser-env.ts";

type Session = { id: string; threadRef: string; scopeId: string; title: string; parentSessionId?: string };
const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  threadRef: `web:tester:${id}`,
  scopeId: "personal:tester",
  title: `Title ${id}`,
  ...extra,
});
let known: Session[] = [];
const env = await browserEnv({
  fetch: async (input) => {
    const path = String(input);
    if (path.startsWith("/api/runtime-config"))
      return Response.json({
        scopeId: "personal:tester",
        approvedHarnesses: [],
        modelsByHarness: {},
        modelCatalog: {},
        effective: { harnessId: "pi", modelId: "m" },
      });
    if (path.endsWith("/approvals")) return Response.json({ approvals: [] });
    if (path === "/api/sessions") return Response.json({ sessions: known });
    const id = path.match(/^\/api\/sessions\/([^/?]+)/)?.[1];
    if (id) return Response.json({ session: known.find((s) => s.id === id), entries: [] });
    return Response.json({ contexts: [], items: [], crons: [] });
  },
});
after(env.close);

let shell: Record<string, any>;
let sessions: Record<string, any>;
let split: Record<string, any>;

beforeEach(async () => {
  document.body.innerHTML = '<div id="app"></div><main></main>';
  env.dom.window.history.replaceState(null, "", "/");
  env.vite.moduleGraph.invalidateAll();
  shell = await env.vite.ssrLoadModule("/src/shell.ts");
  sessions = await env.vite.ssrLoadModule("/src/sessions.ts");
  split = await env.vite.ssrLoadModule("/src/split.ts");
  shell.appState.me = { user: "tester", org: "test" };
  shell.appState.currentView = "chats";
  shell.appState.mainEl = document.querySelector("main");
});

const url = () => `${location.pathname}${location.search}`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function canvas(...open: Session[]): Promise<void> {
  known = [...known, ...open.filter((s) => !known.includes(s))];
  sessions.sessionsState.list = known;
  split.mountRestoredCanvas();
  await sessions.openSession(open[0]);
  for (const next of open.slice(1)) {
    split.beginSessionDrag(next);
    document.querySelector(".zone-right")!.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await settle();
  }
}

const labels = () =>
  [...document.querySelectorAll(".split-pane-actions [aria-label]")].map((el) => el.getAttribute("aria-label"));
const closePane = async (index: number) => {
  document.querySelectorAll<HTMLButtonElement>('.split-pane-actions [aria-label="Close pane"]')[index]!.click();
  await settle();
};

test("pane header updates scan session metadata linearly and retain parent-title invalidation", async () => {
  let reads = 0;
  known = Array.from({ length: 128 }, (_, index) => {
    const row = session(`session-${index}`, index === 126 ? { parentSessionId: "session-0" } : {});
    let id = row.id;
    return Object.defineProperty(row, "id", {
      enumerable: true,
      get() {
        reads++;
        return id;
      },
      set(value: string) {
        id = value;
      },
    });
  });
  await canvas(known[126]!, known[127]!);
  assert.equal(document.querySelector(".split-pane-parent")?.textContent?.trim(), "Title session-0");
  reads = 0;
  sessions.sessionsState.list.find((row: Session) => row.id === "session-0").title = "Renamed parent";
  split.notifyPanesChanged();
  assert.ok(reads <= known.length * 2 * 8, `Header update visited ${reads} session IDs`);
  assert.equal(document.querySelector(".split-pane-parent")?.textContent?.trim(), "Renamed parent");
});

test("single-pane navigation follows the pane identity without depending on the session list", async () => {
  known = [];
  await canvas(session("first"));
  assert.equal(url(), "/s/first");
  history.replaceState(null, "", "/s/first?seq=120");
  shell.syncUrlFromState();
  assert.equal(url(), "/s/first?seq=120");
  shell.syncUrlFromState("stale-override");
  assert.equal(url(), "/s/first?seq=120");
  await canvas(session("first"), session("second"));
  assert.equal(url(), "/");
  await closePane(0);
  assert.equal(url(), "/s/second");
  shell.appState.currentView = "files";
  shell.syncUrlFromState();
  assert.equal(url(), "/files");
  shell.appState.currentView = "chats";
  split.exitSplitIfActive();
  shell.syncUrlFromState("phone-session");
  assert.equal(url(), "/s/phone-session");
});

test("background canvas updates preserve non-chat detail routes", async () => {
  known = [];
  await canvas(session("first"));
  for (const view of ["crons", "webhooks", "inbox", "skills", "contexts"]) {
    shell.appState.currentView = view;
    history.replaceState(null, "", `/${view}/detail`);
    sessions.sessionsState.list[0].title = `Renamed for ${view}`;
    split.notifyPanesChanged();
    split.openBackgroundInCanvas(session(`background-${view}`));
    await settle();
    assert.equal(url(), `/${view}/detail`, `${view} detail URL must stay intact`);
  }
  shell.appState.currentView = "chats";
  sessions.sessionsState.list[0].title = "Back in chats";
  split.notifyPanesChanged();
  const single = split.singlePaneSessionId();
  assert.equal(url(), single ? `/s/${single}` : "/");
});

test("single and multiview headers render mutually exclusive tools and pane controls", async () => {
  known = [];
  await canvas(session("first"));
  assert.equal(document.querySelectorAll(".split-pane-actions .session-tool").length, 6);
  assert.deepEqual(
    labels().filter((label) => /Tools|Split this pane|Open full screen|Close pane/.test(label!)),
    [],
  );
  await canvas(session("first"), session("second"));
  assert.equal(document.querySelectorAll(".split-pane-actions .session-tool").length, 0);
  for (const label of ["Tools", "Split this pane with a new session", "Open full screen", "Close pane"])
    assert.ok(labels().includes(label), label);
  document.querySelector<HTMLButtonElement>(".split-tools-btn")!.click();
  assert.ok(document.querySelector('.split-pane-actions [role="menu"]'));
  await closePane(1);
  assert.equal(document.querySelector('.split-pane-actions [role="menu"]'), null);
  assert.equal(document.querySelector(".split-tools-btn"), null);
  assert.equal(document.querySelectorAll('.split-pane-actions [aria-label="Close pane"]').length, 0);
});

test("a pane that switches to another conversation in place, like a fork, records the new session", () => {
  const params: { sessionId?: string; threadRef?: string } = { sessionId: "original", threadRef: "web:t:original" };
  let syncs = 0;
  const note = runInNewContext(compile(`${functionSource(split, "notePaneSession")}\nnotePaneSession;`), {
    dockApi: {
      getPanel: () => ({ api: { updateParameters: (next: object) => Object.assign(params, next) } }),
    },
    panelParams: () => params,
    persist: () => {},
    refreshHeaders: () => {},
    appState: { currentView: "chats" },
    syncUrlFromState: () => syncs++,
  }) as (paneId: string, sessionId: string | null, threadRef: string | null) => void;
  note("pane", "original", "web:t:original");
  assert.equal(syncs, 0, "an unchanged pane is left alone");
  note("pane", null, "web:t:draft");
  assert.equal(params.sessionId, "original", "a pane never loses its saved session to a session-less update");
  note("pane", "forked", "web:t:forked");
  assert.deepEqual(params, { sessionId: "forked", threadRef: "web:t:forked" });
  assert.equal(syncs, 1, "the address bar follows the pane to the fork");
});
