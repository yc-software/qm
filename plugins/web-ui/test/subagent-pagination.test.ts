import assert from "node:assert/strict";
import test from "node:test";
import {
  projectSessionNavigation,
  projectSessionPage,
  resolveSessionReferences,
} from "../../../src/api/session-navigation.ts";
import type { Session } from "../../../src/types.ts";
import { harness } from "./deep-link-boot-fixture.ts";

const row = (id: string, fields: Partial<Session> = {}): Session => ({
  id,
  threadRef: `web:tester:${id}`,
  scopeId: "personal:tester",
  type: "dm",
  title: id,
  createdAt: 1,
  lastActivityAt: 1,
  ...fields,
});
const until = async (check: () => boolean) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), document.querySelector(".main")?.textContent?.slice(0, 3000));
};
const strip = () => document.querySelector<HTMLElement>(".subagent-activity");
const displayed = () => [...document.querySelectorAll<HTMLElement>(".subagent-row")];
const more = () => document.querySelector<HTMLButtonElement>('[data-session-page="subagents"]');
const expand = () => {
  if (!strip()?.classList.contains("expanded"))
    strip()?.querySelector<HTMLButtonElement>(".bg-activity-strip")?.click();
};
function model(rows: Session[]) {
  const calls: Record<string, unknown>[] = [];
  let intercept:
    ((body: Record<string, unknown>, init?: RequestInit) => Response | Promise<Response> | undefined) | undefined;
  const onRequest = (path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (path === "/api/session-navigation")
      return Response.json(projectSessionNavigation(rows, rows, [], "tester", body));
    if (path === "/api/session-navigation/resolve")
      return Response.json(resolveSessionReferences(rows, body.references));
    if (path === "/api/session-navigation/page") {
      calls.push(body);
      return intercept?.(body, init) ?? Response.json(projectSessionPage(rows, [], body));
    }
    return undefined;
  };
  return {
    rows,
    calls,
    onRequest,
    intercept: (value: typeof intercept) => {
      intercept = value;
    },
  };
}

test("paged subagent elapsed time advances and its ticker stops when the chat is torn down", async (t) => {
  const root = row("root");
  const child = row("working", { parentSessionId: root.id, working: true, createdAt: Date.now() - 1000 });
  const m = model([root, child]);
  const h = await harness({ path: "/s/root", session: root, listSessions: m.rows, onRequest: m.onRequest });
  const starts = t.mock.method(globalThis, "setInterval");
  const clears = t.mock.method(globalThis, "clearInterval");
  try {
    await h.boot();
    await until(() => displayed().length === 1);
    const elapsed = () => strip()?.querySelector(".subagent-row-meta")?.textContent;
    const first = elapsed();
    assert.match(first ?? "", /working/);
    await until(() => elapsed() !== first);
    const tickers = starts.mock.calls.filter((call) => call.arguments[1] === 1000).map((call) => call.result);
    assert.equal(tickers.length, 1);
    h.visibleConversation().teardown();
    assert.ok(
      clears.mock.calls.some((call) => call.arguments[0] === tickers[0]),
      "subagent ticker was not stopped",
    );
  } finally {
    starts.mock.restore();
    clears.mock.restore();
    await h.close();
  }
});

test("zero active summary still reads old failed descendants with true depth behind idle siblings", async () => {
  const root = row("root", { subagents: { running: 0, waiting: 0 } });
  const chain = Array.from({ length: 6 }, (_, i) =>
    row(`chain-${i}`, { parentSessionId: i ? `chain-${i - 1}` : root.id }),
  );
  const leaf = row("failed-leaf", { parentSessionId: "chain-5", lastTurnFailed: true, lastActivityAt: 0 });
  const m = model([
    root,
    ...Array.from({ length: 65 }, (_, i) => row(`idle-${i}`, { parentSessionId: root.id, lastActivityAt: 100 })),
    ...chain,
    leaf,
  ]);
  const h = await harness({ path: "/s/root", session: root, listSessions: m.rows, onRequest: m.onRequest });
  try {
    await h.boot();
    await until(() => displayed().some((element) => element.dataset.sessionId === leaf.id));
    assert.equal(displayed().length, 1);
    assert.equal(displayed()[0]!.dataset.depth, "7");
    assert.ok(
      m.calls.some((body) => body.parentSessionId === root.id && body.children === true && body.actionable === true),
    );
    assert.equal(h.requests.includes("/api/sessions"), false);
    assert.equal(
      h.sessionsState.list.some((session) => session.id === "chain-5"),
      false,
    );
    assert.equal(more(), null);
    displayed()[0]!.querySelector<HTMLButtonElement>(".subagent-row-head")!.click();
    await until(() =>
      h.requests.some((path) => path.startsWith(`/api/sessions/${leaf.id}?`) && path.includes("tailTurns=1")),
    );
    const open = [...displayed()[0]!.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Open",
    )!;
    open.click();
    await until(() => h.visibleConversation().state.sessionId === leaf.id);
  } finally {
    await h.close();
  }
});

test("fifty dismissed failures keep explicit continuation and background refresh preserves only opened depth", async () => {
  const root = row("root");
  const m = model([
    root,
    ...Array.from({ length: 103 }, (_, i) =>
      row(`failed-${String(i).padStart(3, "0")}`, { parentSessionId: root.id, lastTurnFailed: true }),
    ),
  ]);
  const h = await harness({ path: "/s/root", session: root, listSessions: m.rows, onRequest: m.onRequest });
  try {
    await h.boot();
    await until(() => strip()?.dataset.loaded === "50" && strip()?.dataset.sessionPageState === "ready");
    expand();
    assert.equal(displayed().length, 50);
    assert.match(strip()!.textContent!, /50 failed loaded, more available/);
    const firstRequests = m.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(m.calls.length, firstRequests);
    for (let i = 0; i < 50; i++)
      [...displayed()[0]!.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Dismiss")!
        .click();
    assert.equal(displayed().length, 0);
    assert.ok(more());
    more()!.click();
    await until(() => strip()?.dataset.loaded === "100" && !more()?.disabled);
    assert.equal(displayed().length, 50);
    const before = m.calls.length;
    await h.refreshSessions();
    await until(() => m.calls.length === before + 2 && strip()?.dataset.loaded === "100" && !more()?.disabled);
    assert.equal(m.calls[before]!.cursor, undefined);
    assert.equal(typeof m.calls[before + 1]!.cursor, "string");
    assert.equal(displayed().length, 50);
    more()!.click();
    await until(() => strip()?.dataset.loaded === "103" && more() === null);
    assert.equal(displayed().length, 53);
    assert.equal(h.requests.includes("/api/sessions"), false);
  } finally {
    await h.close();
  }
});

test("old continuation cannot restore removed rows after refresh and parent revocation clears retained summary", async () => {
  const root = row("root");
  const m = model([
    root,
    ...Array.from({ length: 60 }, (_, i) =>
      row(`working-${String(i).padStart(3, "0")}`, { parentSessionId: root.id, working: true }),
    ),
  ]);
  const h = await harness({ path: "/s/root", session: root, listSessions: m.rows, onRequest: m.onRequest });
  let release: (() => void) | undefined;
  try {
    await h.boot();
    await until(() => strip()?.dataset.loaded === "50" && !more()?.disabled);
    expand();
    assert.match(strip()!.textContent!, /60 subagents running/);
    m.intercept((body) => {
      if (body.cursor) {
        const captured = projectSessionPage(m.rows, [], body);
        return new Promise<Response>((resolve) => {
          release = () => resolve(Response.json(captured));
        });
      }
      return undefined;
    });
    more()!.click();
    await until(() => Boolean(release));
    m.rows.splice(1, m.rows.length - 1, row("fresh", { parentSessionId: root.id, lastTurnFailed: true }));
    m.intercept(undefined);
    await h.refreshSessions();
    await until(() => displayed().some((element) => element.dataset.sessionId === "fresh"));
    release!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      displayed().map((element) => element.dataset.sessionId),
      ["fresh"],
    );
    assert.deepEqual(h.sessionsState.list.find((session) => session.id === root.id)?.subagents, {
      running: 0,
      waiting: 0,
    });
    m.rows.splice(0, m.rows.length);
    await h.refreshSessions();
    await until(() => strip() === null);
    assert.equal(
      h.sessionsState.list.some((session) => session.id === root.id),
      false,
    );
  } finally {
    release?.();
    await h.close();
  }
});

test("actionable failure stays explicit and retry never falls back on a denied request", async () => {
  const root = row("root");
  const m = model([root, row("child", { parentSessionId: root.id, lastTurnFailed: true })]);
  m.intercept(() => Response.json({ error: "denied" }, { status: 403 }));
  const h = await harness({ path: "/s/root", session: root, listSessions: m.rows, onRequest: m.onRequest });
  try {
    await h.boot();
    await until(() => strip()?.dataset.sessionPageState === "error");
    assert.equal(displayed().length, 0);
    assert.equal(h.requests.includes("/api/sessions"), false);
    m.intercept(undefined);
    strip()!.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await until(() => displayed().some((element) => element.dataset.sessionId === "child"));
    assert.equal(strip()?.dataset.sessionPageState, "ready");
  } finally {
    await h.close();
  }
});

test("targeted resolution preserves omitted summary, accepts explicit zero, and evicts an authoritative null", async () => {
  const root = row("root", { subagents: { running: 3, waiting: 2 } });
  const m = model([root]);
  const h = await harness({ path: "/settings", onRequest: m.onRequest });
  try {
    delete root.subagents;
    h.sessionsState.list = [{ ...root, subagents: { running: 3, waiting: 2 } }];
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.resolveSessionReference({ kind: "id", value: root.id });
    assert.deepEqual(h.sessionsState.list[0]?.subagents, { running: 3, waiting: 2 });
    root.subagents = { running: 0, waiting: 0 };
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.resolveSessionReference({ kind: "id", value: root.id });
    assert.deepEqual(h.sessionsState.list[0]?.subagents, { running: 0, waiting: 0 });
    m.rows.splice(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(await h.resolveSessionReference({ kind: "id", value: root.id }), null);
    assert.equal(h.sessionsState.list.length, 0);
  } finally {
    await h.close();
  }
});

test("actionable transport refuses malformed depth, parent, state and summary without legacy fallback", async () => {
  const root = row("root");
  const rows = [root, row("child", { parentSessionId: root.id, lastTurnFailed: true })];
  const request = { parentSessionId: root.id, children: true, actionable: true };
  const valid = projectSessionPage(rows, [], request);
  let response = valid;
  const h = await harness({ path: "/settings", onRequest: () => Response.json(response) });
  try {
    for (const bad of [
      { ...valid, actionable: undefined },
      ...[
        { depths: [] },
        { depths: [0] },
        { depths: [-1] },
        { depths: [1.5] },
        { parentSessionId: "other" },
        { parentSubagents: null },
        { parentSubagents: { running: -1, waiting: 0 } },
      ].map((patch) => ({ ...valid, actionable: { ...valid.actionable!, ...patch } })),
      { ...valid, items: [{ ...valid.items[0]!, lastTurnFailed: false }] },
    ]) {
      response = bad;
      await assert.rejects(h.navigationTransport.fetchSessionPage(request), /Invalid session navigation/);
    }
    response = valid;
    assert.deepEqual(await h.navigationTransport.fetchSessionPage(request), valid);
    assert.equal(h.requests.includes("/api/sessions"), false);
  } finally {
    await h.close();
  }
});

for (const status of [200, 403]) {
  test(`late actionable ${status} cannot repaint Settings or replace a subsequent parent`, async () => {
    const root = row("root");
    const m = model([root, row("child", { parentSessionId: root.id, lastTurnFailed: true })]);
    const releases: (() => void)[] = [];
    m.intercept(
      (body) =>
        new Promise<Response>((resolve) => {
          const value = projectSessionPage(m.rows, [], body);
          releases.push(() => resolve(Response.json(status === 200 ? value : { error: "denied" }, { status })));
        }),
    );
    const h = await harness({
      path: "/s/root",
      session: root,
      listSessions: m.rows,
      onRequest: m.onRequest,
      entries: [{ seq: 0, type: "user", createdAt: 1, payload: { text: "" } }],
    });
    try {
      await h.boot();
      await until(() => releases.length > 0);
      h.switchView("settings");
      m.intercept(undefined);
      releases.forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(h.appState.currentView, "settings");
      assert.equal(strip(), null);
      const other = row("other-root");
      const otherChild = row("other-child", { parentSessionId: other.id, lastTurnFailed: true });
      m.rows.push(other, otherChild);
      await h.openSession(other);
      await until(() => displayed().some((element) => element.dataset.sessionId === otherChild.id));
      assert.equal(strip()?.dataset.parentSessionId, other.id);
      assert.equal(
        displayed().some((element) => element.dataset.sessionId === "child"),
        false,
      );
      assert.equal(strip()?.dataset.sessionPageState, "ready");
    } finally {
      releases.forEach((release) => release());
      await h.close();
    }
  });
}

test("off-page parent gets full waiting/running summary and waiting rows keep exact approval controls", async () => {
  const root = row("off-page", { lastActivityAt: -100 });
  const m = model([
    root,
    ...Array.from({ length: 65 }, (_, i) => row(`newer-${i}`)),
    row("working", { parentSessionId: root.id, working: true }),
    row("waiting", { parentSessionId: root.id, awaitingInput: true, working: true }),
  ]);
  const h = await harness({ path: "/s/off-page", session: root, listSessions: m.rows, onRequest: m.onRequest });
  try {
    await h.boot();
    await until(() => displayed().length === 2);
    assert.deepEqual(h.sessionsState.list.find((session) => session.id === root.id)?.subagents, {
      running: 1,
      waiting: 1,
    });
    assert.match(strip()!.textContent!, /1 subagent running, 1 needs you/);
    assert.ok(h.requests.includes("/api/sessions/waiting/approvals"));
    assert.equal(h.requests.includes("/api/sessions/working/approvals"), false);
    assert.equal(h.requests.includes("/api/sessions"), false);
  } finally {
    await h.close();
  }
});
