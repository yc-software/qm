import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { Principal, TurnRequest } from "../src/types.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { testConfig } from "./support/test-config.ts";

function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-working-"));
  return buildApp(testConfig({ dataDir }));
}

const actor = { externalId: "U1" };
function dm(text: string, thread: string): TurnRequest {
  return { surface: "test", actor, conversation: { kind: "dm", threadRef: thread }, text };
}

function enqueueRequest(): OrchestratorInput {
  const principal: Principal = { id: "internal:U1", type: "internal" };
  return {
    actor: principal,
    conversation: { kind: "dm", threadRef: "t", audience: [principal] },
    origin: { kind: "direct" },
    text: "working",
  };
}

test("listSessions flags a session with an in-flight turn as working", async () => {
  const { app, runs } = freshApp();

  await app.turn(dm("Just a question", "web:U1:idle"));

  const busyThread = "web:U1:busy";
  const busy = await app.turn(dm("Kick something off", busyThread));
  const busyId = busy.sessionId!;
  assert.ok(busyId);
  assert.notEqual(busyId, busyThread, "session UUID and threadRef are distinct (the trap)");
  await runs.enqueue({ sessionId: busyThread, request: enqueueRequest() });

  const list = await app.listSessions("U1");
  const busyRow = list.find((s) => s.threadRef === busyThread);
  const idleRow = list.find((s) => s.threadRef === "web:U1:idle");

  assert.equal(busyRow?.working, true, "the session with an in-flight run is flagged working");
  assert.ok(idleRow, "the idle session is still listed");
  assert.ok(!idleRow!.working, "a settled session is not flagged");
});

test("the working flag clears once the in-flight run settles", async () => {
  const { app, runs } = freshApp();
  const thread = "web:U1:settle";
  await app.turn(dm("start", thread));
  await runs.enqueue({ sessionId: thread, request: enqueueRequest() });

  assert.equal((await app.listSessions("U1")).find((r) => r.threadRef === thread)?.working, true);

  const claimed = await runs.claim("w1", 5_000);
  assert.equal(claimed?.sessionId, thread, "the run is keyed by threadRef");
  await runs.complete(claimed!.id, claimed!.leaseToken ?? "", { status: "ok", reply: "done" });

  assert.ok(
    !(await app.listSessions("U1")).find((r) => r.threadRef === thread)?.working,
    "the flag clears once the run is terminal",
  );
});
