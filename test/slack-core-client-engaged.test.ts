import assert from "node:assert/strict";
import { test } from "node:test";
import { createSlackCoreClient } from "../src/api/slack-core-client.ts";
import { createTurnStream } from "../src/runs/turn-stream.ts";

function harness() {
  const turnStream = createTurnStream();
  let run: { id: string; status: string; attempts: number; leaseExpiresAt?: number } = {
    id: "r1",
    status: "running",
    attempts: 1,
  };
  let wake: ((run: { id: string }) => void) | undefined;
  const client = createSlackCoreClient({
    app: { getRun: async () => ({ result: { status: "ok", reply: "done" } }) },
    runs: {
      get: async () => run,
      onTerminal: (cb: (run: { id: string }) => void) => {
        wake = cb;
      },
    },
    turnStream,
    tasks: { list: async () => [] },
    config: {},
    runtimeFallback: { harnessId: "pi", modelId: "m" },
    blobTransfer: {},
    deliveries: {},
    metrics: {},
    agentRequests: {},
  } as any);
  return {
    client,
    turnStream,
    finish: (status: string) => {
      run = { ...run, status };
      wake?.(run);
    },
    poke: () => wake?.(run),
  };
}

test("waitRun signals engagement once the turn stream begins, not when the run merely starts", async () => {
  const h = harness();
  const events: string[] = [];
  const waiting = h.client.waitRun("r1", { onEngaged: () => events.push("engaged") });
  await new Promise((r) => setTimeout(r, 20));
  h.poke();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events, []);
  h.turnStream.begin("r1");
  h.poke();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events, ["engaged"]);
  h.turnStream.publish("r1", "hello");
  h.turnStream.noteToolCall("r1");
  h.poke();
  await new Promise((r) => setTimeout(r, 20));
  h.finish("done");
  const result = await waiting;
  assert.equal(result?.status, "ok");
  assert.deepEqual(events, ["engaged"]);
});

test("waitRun never signals engagement for a run that ends without beginning a turn", async () => {
  const h = harness();
  const events: string[] = [];
  const waiting = h.client.waitRun("r1", { onEngaged: () => events.push("engaged") });
  await new Promise((r) => setTimeout(r, 20));
  h.finish("done");
  await waiting;
  assert.deepEqual(events, []);
});
