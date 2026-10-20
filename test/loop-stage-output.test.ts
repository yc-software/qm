import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import { createLoopFireService } from "../src/loops/loop-fire.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

function stageOf(req: TurnRequest): string {
  return /^\[Loop (\w+)\]/.exec(req.text ?? "")?.[1] ?? "other";
}

async function harness(submissions: (stage: string, attempt: number) => unknown) {
  const built = buildApp(testConfig());
  const { store: loops, items, outputs, grants } = built.loops;
  const results: Array<{ stage: string; reply?: string; stageOutput?: unknown }> = [];
  const attempts = new Map<string, number>();
  const fire = createLoopFireService({
    loops,
    items,
    outputs,
    grants,
    trigger: {
      identity: built.identity,
      deliveries: built.deliveries,
      idempotency: createIdempotencyStore(),
      run: async (req) => {
        const stage = stageOf(req);
        const attempt = (attempts.get(stage) ?? 0) + 1;
        attempts.set(stage, attempt);
        assert.ok(req.stageOutput, `${stage} declares its output`);
        const result = await built.app.turn({
          ...req,
          text: `!submit-stage ${JSON.stringify(submissions(stage, attempt))}`,
        });
        results.push({ stage, reply: result.reply, stageOutput: result.stageOutput });
        return result;
      },
    },
  });
  const { loop } = await loops.create({
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    name: "Error RCA",
    playbook: "Read errors and prepare an RCA.",
    successCondition: "An RCA is prepared.",
    shipActions: [{ action: "open_pr", gate: "hold" }],
    caps: { maxItemAttempts: 2 },
  });
  return { fire, loop, items, outputs, results };
}

const VALID: Record<string, unknown> = {
  intake: { items: [{ sourceKey: "ERROR-1", sourceSummary: "Synthetic error" }] },
  work: { outputs: [{ shipAction: "open_pr", title: "RCA for ERROR-1", externalRef: "https://example.com/pr/1" }] },
  judge: { outcome: "met", reason: "RCA prepared" },
};

test("stage outputs submitted through the stage tool are recorded on the ledger", async () => {
  const h = await harness((stage) => VALID[stage]);
  const result = await h.fire.fire(h.loop.id, "submitted");
  assert.deepEqual(
    h.results.map(({ stage, reply, stageOutput }) => ({ stage, reply, stageOutput })),
    ["intake", "work", "judge"].map((stage) => ({ stage, reply: "[submitted]", stageOutput: VALID[stage] })),
  );
  assert.equal(result.summary?.enqueued, 1);
  const [item] = await h.items.byLoop(h.loop.id);
  assert.equal(item?.sourceKey, "ERROR-1");
  assert.equal(item?.sourceSummary, "Synthetic error");
  assert.equal(item?.status, "ready");
  const [held] = await h.outputs.awaitingReview(h.loop.id);
  assert.equal(held?.title, "RCA for ERROR-1");
  assert.equal(held?.externalRef, "https://example.com/pr/1");
});

test("a malformed work submission is refused to the model and records no outputs", async () => {
  const h = await harness((stage) =>
    stage === "work" ? { outputs: [{ shipAction: "open_pr", title: "  " }] } : VALID[stage],
  );
  const result = await h.fire.fire(h.loop.id, "malformed");
  const work = h.results.find(({ stage }) => stage === "work");
  assert.equal(work?.stageOutput, undefined);
  assert.match(work?.reply ?? "", /^\[error\] invalid submit_stage_output arguments: \/outputs\/0\/title/);
  assert.equal(
    h.results.some(({ stage }) => stage === "judge"),
    false,
  );
  assert.match(result.summary?.failures.join("\n") ?? "", /ERROR-1: work: nothing submitted — \[error\] invalid/);
  const [item] = await h.items.byLoop(h.loop.id);
  assert.equal(item?.status, "queued");
  assert.equal(item?.runIds.length, 1);
  assert.deepEqual(await h.outputs.awaitingReview(h.loop.id), []);
});
