import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";
import { collectSessionReadTiming, timeSessionRead } from "../src/sessions/read-timing.ts";

function stages(header: string | null): Map<string, number> {
  assert.ok(header);
  return new Map(
    header.split(", ").map((metric) => {
      const [name, duration] = metric.split(";dur=");
      const ms = Number(duration);
      assert.ok(name?.startsWith("qm_session_"));
      assert.ok(Number.isFinite(ms) && ms >= 0);
      return [name!.slice("qm_session_".length), ms];
    }),
  );
}

test("session HTTP reads expose executed stages without changing payloads or authorization", async (t) => {
  const built = buildApp(testConfig());
  const scope = scopeId("personal", "viewer");
  const session = await built.sessions.getOrCreateByThread("web:viewer:timing", "dm", scope, undefined, "web");
  await built.sessions.addParticipant(session.id, "viewer");
  const { lease } = await built.sessions.acquireLease(session.id);
  assert.ok(lease);
  await built.sessions.append(lease, { type: "user", payload: { text: "hello" }, scopeLabel: scope });
  await built.sessions.releaseLease(lease);
  await built.sessions.addPin(session.id, { entrySeq: 0, addedBy: "viewer" });
  const server = createInsecureTestServer(built.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const expected = await built.app.getSessionForViewer(session.id, "viewer", { tailTurns: 1 });
  const response = await fetch(`${base}/v1/sessions/${session.id}?viewer=viewer&tailTurns=1`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  const measured = stages(response.headers.get("server-timing"));
  assert.deepEqual([...measured.keys()].sort(), ["pins", "total", "transcript"]);
  assert.ok(measured.get("total")! >= measured.get("transcript")!);

  const denied = await fetch(`${base}/v1/sessions/${session.id}?viewer=stranger`);
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), { error: "not_found" });
  assert.deepEqual([...stages(denied.headers.get("server-timing")).keys()].sort(), ["total"]);

  t.mock.method(built.sessions, "listPins", async () => {
    throw new Error("pins unavailable");
  });
  const failed = await fetch(`${base}/v1/sessions/${session.id}?viewer=viewer`);
  assert.equal(failed.status, 500);
  const failedStages = stages(failed.headers.get("server-timing"));
  for (const name of ["total", "pins"]) assert.ok(failedStages.has(name), name);
});

test("session timings aggregate repeats and isolate overlapping request contexts", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstTimings = new Map<string, number>();
  const secondTimings = new Map<string, number>();
  const first = collectSessionReadTiming(firstTimings, async () => {
    await timeSessionRead("transcript", async () => {
      now += 2;
      await waiting;
    });
    await timeSessionRead("transcript", () => {
      now += 3;
    });
    return "first";
  });
  const second = await collectSessionReadTiming(secondTimings, () =>
    timeSessionRead("pins", () => {
      now += 5;
      return "second";
    }),
  );
  release();
  const completed = await first;
  assert.equal(completed, "first");
  assert.equal(second, "second");
  assert.equal(firstTimings.get("transcript"), 10);
  assert.equal(firstTimings.has("pins"), false);
  assert.equal(secondTimings.get("pins"), 5);
  assert.equal(secondTimings.has("transcript"), false);
});
