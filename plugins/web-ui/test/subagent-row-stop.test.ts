import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoreSession } from "../src/core-bridge.ts";
import { item } from "./item-fixture.ts";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
}

const lane = (id: string, title: string): CoreSession => ({
  id,
  threadRef: `agent:main:subagent:${id}`,
  scopeId: "personal:tester",
  type: "dm",
  title,
  createdAt: Date.now() - 60_000,
  parentSessionId: SESSION.id,
  working: true,
});

interface Fixture {
  lanes: CoreSession[];
  signals: Array<{ path: string; body: unknown }>;
  failSignal: boolean;
  holdSignal: Promise<void> | null;
}

async function strip(fixture: Fixture) {
  const runFor = (threadRef: string) => fixture.lanes.find((row) => row.threadRef === threadRef && row.working);
  return harness({
    path: `/s/${SESSION.id}`,
    listSessions: [SESSION, ...fixture.lanes],
    items: [item("UserMessage", { seq: 1, createdAt: Date.now() - 30_000, text: "fan out the work" })],
    api: (path, init) => {
      if (path.startsWith("/api/runs/active?")) {
        const threadRef = new URL(path, "http://test").searchParams.get("threadRef") ?? "";
        const live = runFor(threadRef);
        return Response.json(
          live
            ? {
                runId: `run-${live.id}`,
                run: { status: "running", alive: true, startedAt: Date.now(), attempt: 1, activity: [], result: null },
              }
            : { runId: null, run: null, queued: [] },
        );
      }
      const signal = /^\/api\/runs\/run-([^/]+)\/signal$/.exec(path);
      if (signal && init?.method === "POST")
        return (async () => {
          fixture.signals.push({ path, body: JSON.parse(String(init.body)) });
          if (fixture.holdSignal) await fixture.holdSignal;
          if (fixture.failSignal) return Response.json({ error: "boom" }, { status: 500 });
          const stopped = fixture.lanes.find((row) => row.id === signal[1]);
          if (stopped) stopped.working = false;
          return Response.json({ accepted: true });
        })();
      const opened = fixture.lanes.find(
        (row) => path === `/api/sessions/${row.id}` || path.startsWith(`/api/sessions/${row.id}?`),
      );
      if (opened)
        return Response.json({
          session: opened,
          items: [item("AgentMessage", { seq: 1, createdAt: Date.now(), text: `Transcript of ${opened.title}` })],
        });
      return undefined;
    },
  });
}

function present<T>(value: T | null | undefined): T {
  assert.ok(value);
  return value;
}

const main = () => present(document.querySelector<HTMLElement>(".main"));
const rowFor = (title: string) =>
  [...main().querySelectorAll<HTMLElement>(".subagent-row")].find((row) =>
    row.querySelector(".subagent-row-title")?.textContent?.includes(title),
  );
const stopFor = (title: string) => rowFor(title)?.querySelector<HTMLButtonElement>(".subagent-row-stop") ?? null;

async function expandedStrip(h: Awaited<ReturnType<typeof strip>>): Promise<void> {
  h.releaseSessions();
  await h.boot();
  await h.sessionsReady();
  await until(() => /2 subagents running/.test(main().textContent ?? ""));
  present(main().querySelector<HTMLButtonElement>(".bg-activity-strip")).click();
  await until(() => stopFor("Schema lane") !== null && stopFor("Backfill lane") !== null);
}

test("a row's Stop stops only that subagent's current run", async () => {
  let release = (): void => {};
  const fixture: Fixture = {
    lanes: [lane("lane-a", "Schema lane"), lane("lane-b", "Backfill lane")],
    signals: [],
    failSignal: false,
    holdSignal: new Promise<void>((resolve) => (release = resolve)),
  };
  const h = await strip(fixture);
  try {
    await expandedStrip(h);
    assert.equal(main().querySelector(".subagent-stop-all"), null);
    present(stopFor("Schema lane")).click();
    await until(() => fixture.signals.length === 1);
    assert.deepEqual(fixture.signals[0], { path: "/api/runs/run-lane-a/signal", body: { kind: "abort" } });
    await until(() => stopFor("Schema lane")?.disabled === true);
    assert.equal(present(stopFor("Schema lane")).textContent?.trim(), "Stopping…");
    assert.equal(present(stopFor("Backfill lane")).textContent?.trim(), "Stop");
    release();
    await until(() => rowFor("Schema lane") === undefined);
    assert.equal(present(stopFor("Backfill lane")).textContent?.trim(), "Stop");
    assert.equal(fixture.signals.length, 1);
    assert.equal(location.pathname, `/s/${SESSION.id}`);
  } finally {
    await h.close();
  }
});

test("a failed row Stop shows an inline error and lets the person retry", async () => {
  const fixture: Fixture = {
    lanes: [lane("lane-a", "Schema lane"), lane("lane-b", "Backfill lane")],
    signals: [],
    failSignal: true,
    holdSignal: null,
  };
  const h = await strip(fixture);
  try {
    await expandedStrip(h);
    present(stopFor("Schema lane")).click();
    await until(() => rowFor("Schema lane")?.querySelector(".subagent-row-error") !== null);
    assert.equal(
      present(rowFor("Schema lane")?.querySelector(".subagent-row-error")).textContent?.trim(),
      "Couldn't stop",
    );
    assert.equal(present(stopFor("Schema lane")).disabled, false);
    assert.equal(present(stopFor("Schema lane")).textContent?.trim(), "Stop");
    fixture.failSignal = false;
    present(stopFor("Schema lane")).click();
    await until(() => stopFor("Schema lane") === null);
    assert.equal(fixture.signals.length, 2);
  } finally {
    await h.close();
  }
});

test("clicking a row opens that subagent", async () => {
  const fixture: Fixture = {
    lanes: [lane("lane-a", "Schema lane"), lane("lane-b", "Backfill lane")],
    signals: [],
    failSignal: false,
    holdSignal: null,
  };
  const h = await strip(fixture);
  try {
    await expandedStrip(h);
    present(rowFor("Backfill lane")?.querySelector<HTMLButtonElement>(".subagent-row-head")).click();
    await until(() => location.pathname === "/s/lane-b");
    await until(() => h.requests.some((path) => path.startsWith("/api/sessions/lane-b")));
    await until(() => main().querySelector(".subagent-row") === null);
    assert.equal(fixture.signals.length, 0);
  } finally {
    await h.close();
  }
});
