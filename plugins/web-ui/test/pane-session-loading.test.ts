import assert from "node:assert/strict";
import test from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

test("opening a restored hidden tab from the sidebar fetches its transcript once", async () => {
  const sessions = [SESSION, { id: "b", threadRef: "web:tester:b", scopeId: "personal:tester", title: "b" }];
  const h = await harness({
    path: "/",
    welcome: true,
    listSessions: sessions,
    remoteCanvas: {
      v: 2,
      active: true,
      layout: {
        grid: {
          root: {
            type: "branch",
            data: [{ type: "leaf", data: { views: [SESSION.id, "b"], activeView: "b", id: "stack" } }],
          },
          width: 1000,
          height: 800,
          orientation: "HORIZONTAL",
        },
        panels: Object.fromEntries(
          sessions.map((session) => [
            session.id,
            {
              id: session.id,
              contentComponent: "pane",
              tabComponent: "pane",
              params: { sessionId: session.id, threadRef: session.threadRef },
              title: session.title,
            },
          ]),
        ),
        activeGroup: "stack",
      },
    },
  });
  try {
    h.releaseSessions();
    await h.boot();
    assert.equal(h.requests.filter((path) => path.includes(SESSION.id)).length, 0);
    await h.openSession({ ...SESSION, type: "dm", createdAt: 1 });
    assert.equal(h.requests.filter((path) => path === `/api/sessions/${SESSION.id}?tailTurns=25`).length, 1);
    assert.equal(h.requests.filter((path) => path === `/api/sessions/${SESSION.id}/approvals`).length, 1);
  } finally {
    await h.close();
  }
});

test("restoring sessions already supplied by the sidebar does not reread the sidebar", async () => {
  const sessions = [
    SESSION,
    ...["b", "c", "d"].map((id) => ({ id, threadRef: `web:tester:${id}`, scopeId: "personal:tester", title: id })),
  ];
  const leaf = (session: (typeof sessions)[number]) => ({
    kind: "leaf",
    sessionId: session.id,
    threadRef: session.threadRef,
  });
  const h = await harness({
    path: "/",
    welcome: true,
    holdRemoteSplit: true,
    listSessions: sessions,
    remoteCanvas: {
      v: 1,
      active: true,
      root: {
        kind: "split",
        a: { kind: "split", a: leaf(sessions[0]!), b: leaf(sessions[1]!) },
        b: { kind: "split", a: leaf(sessions[2]!), b: leaf(sessions[3]!) },
      },
    },
  });
  const booted = h.boot();
  try {
    h.releaseSessions();
    for (let i = 0; i < 100 && !h.sessionsState.loaded; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(h.sessionsState.loaded, true);
    h.releaseRemoteSplit();
    await booted;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(document.querySelectorAll(".split-pane-content").length, 4);
    assert.equal(h.requests.filter((path) => path === "/api/sessions").length, 1);
  } finally {
    h.releaseRemoteSplit();
    await booted;
    await h.close();
  }
});

test("a restored read-only transcript does not wait for unused approvals", async () => {
  const session = { ...SESSION, threadRef: "dm:sample", type: "dm" as const, createdAt: 1 };
  const h = await harness({
    path: "/",
    session,
    holdApprovals: true,
    entries: [{ seq: 1, type: "user", createdAt: 1, payload: { text: "Read-only transcript is ready" } }],
    remoteCanvas: {
      v: 1,
      active: true,
      root: {
        kind: "split",
        a: { kind: "leaf", sessionId: session.id, threadRef: session.threadRef },
        b: { kind: "leaf" },
      },
    },
  });
  try {
    h.releaseSessions();
    await h.boot();
    for (let i = 0; i < 100 && !h.mainText().includes("Read-only transcript is ready"); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.match(h.mainText(), /Read-only transcript is ready/);
  } finally {
    await h.close();
  }
});
