import "./support/auto-fake-sprites.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { buildCore } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("turn state did not reach the edge within 5s");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("live turn state written by the harness core is readable from a separate edge core", async (t) => {
  const config = testConfig();
  const harness = buildCore(config);
  const edge = buildCore({ ...config, dataDir: `${config.dataDir}-edge` });
  t.after(async () => {
    await harness.close();
    await edge.close();
  });
  await new Promise((r) => setTimeout(r, 300));
  const runId = "run-cross-process";
  const firstBlocks: string[] = [];
  let posted = false;
  edge.turnStream.subscribe(runId, {
    onFirstBlock: (text) => firstBlocks.push(text),
    onSurfacePosted: () => (posted = true),
  });

  harness.turnStream.noteRuntime(runId, { modelId: "claude-opus-5" });
  harness.turnStream.noteGoal(runId, { objective: "ship it", status: "active", createdAt: 1, updatedAt: 1 });
  harness.turnStream.publish(runId, "Looking ");
  harness.turnStream.publish(runId, "into it.");
  harness.turnStream.publishReasoning(runId, "s1", 0, "thinking");
  harness.turnStream.noteToolCall(runId);
  harness.turnStream.publishBlockStart(runId);
  harness.turnStream.publish(runId, "Done.");
  harness.turnStream.markSurfacePosted(runId);
  harness.turnStream.markReplyDone(runId);

  await until(
    () => edge.turnStream.isReplyDone(runId) && edge.turnStream.snapshot(runId) === "Looking into it.\n\nDone.",
  );
  assert.deepEqual(edge.turnStream.runtime(runId), { modelId: "claude-opus-5" });
  assert.equal(edge.turnStream.goal(runId)?.objective, "ship it");
  assert.deepEqual(edge.turnStream.firstBlock(runId), { text: "Looking into it.", closed: true });
  assert.deepEqual(firstBlocks, ["Looking into it."]);
  assert.equal(edge.turnStream.surfacePosted(runId), true);
  assert.equal(posted, true);
  assert.deepEqual(
    edge.turnStream.reasoning(runId).map((b) => b.text),
    ["thinking"],
  );
  assert.equal(edge.turnStream.startOffset(runId), 0);
});
