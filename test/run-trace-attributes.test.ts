import { test } from "node:test";
import assert from "node:assert/strict";
import { runTraceAttributes } from "../src/runs/worker.ts";
import type { Run } from "../src/runs/run-store.ts";

const run = (request: Partial<Run["request"]>): Run =>
  ({
    id: "run-1",
    attempts: 1,
    createdAt: 1_000,
    startedAt: 1_250,
    request: { surface: "web", origin: { kind: "human" }, ...request },
  }) as Run;

test("a run a person sent carries its origin and no spawn tag", () => {
  const attributes = runTraceAttributes(run({}));
  assert.equal(attributes["qm.origin"], "human");
  assert.equal(attributes["qm.spawn"], undefined);
  assert.equal(attributes["qm.parent_run"], undefined);
  assert.equal(attributes["messaging.message.receive.latency"], 250);
});

test("a run another run started is tagged delegated with its parent run", () => {
  const attributes = runTraceAttributes(run({ delegatingRunId: "parent-1", sessionSenderId: "session-a" }));
  assert.equal(attributes["qm.origin"], "human");
  assert.equal(attributes["qm.spawn"], "delegated");
  assert.equal(attributes["qm.parent_run"], "parent-1");
});

test("a message from another session is tagged delegated even without a parent run", () => {
  const attributes = runTraceAttributes(run({ sessionSenderId: "session-a" }));
  assert.equal(attributes["qm.spawn"], "delegated");
  assert.equal(attributes["qm.parent_run"], undefined);
});

test("a swarm worker is tagged swarm", () => {
  const attributes = runTraceAttributes(
    run({ origin: { kind: "automation" }, swarm: {} as NonNullable<Run["request"]["swarm"]> }),
  );
  assert.equal(attributes["qm.spawn"], "swarm");
});
