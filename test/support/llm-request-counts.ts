import assert from "node:assert/strict";
import type { SessionStore } from "../../src/sessions/session-store.ts";
import { scopeId } from "../../src/types.ts";

export async function assertLlmRequestCounts(store: SessionStore, prefix: string): Promise<void> {
  const scope = scopeId("personal", prefix);
  const session = await store.getOrCreateByThread(prefix, "dm", scope);
  assert.deepEqual(await store.llmRequestCounts(session.id, 0), []);
  const turnSeqs = [0, 0, 3, 3, 4, 6, null, -1, 2, 99];
  for (const [step, turnSeq] of turnSeqs.entries())
    await store.recordLlmRequest(session.id, {
      turnSeq,
      step,
      model: "model",
      scopeLabel: scope,
      promptEnvelope: { system: "context", messages: [{ role: "user", content: `step ${step}` }] },
      usage: { input: 2, output: 3, totalTokens: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 },
    });
  assert.deepEqual(await store.llmRequestCounts(session.id, 3), [
    { turnSeq: 3, count: 2 },
    { turnSeq: 4, count: 1 },
    { turnSeq: 6, count: 1 },
    { turnSeq: 99, count: 1 },
    { turnSeq: null, count: 1 },
  ]);
  assert.deepEqual(await store.llmRequestCounts(session.id, 4), [
    { turnSeq: 4, count: 1 },
    { turnSeq: 6, count: 1 },
    { turnSeq: 99, count: 1 },
    { turnSeq: null, count: 1 },
  ]);
  assert.deepEqual(await store.llmRequestCounts(session.id, 0), [
    { turnSeq: 0, count: 2 },
    { turnSeq: 2, count: 1 },
    { turnSeq: 3, count: 2 },
    { turnSeq: 4, count: 1 },
    { turnSeq: 6, count: 1 },
    { turnSeq: 99, count: 1 },
    { turnSeq: null, count: 1 },
  ]);
  assert.deepEqual(await store.llmRequestCounts("missing", 0), []);
  assert.deepEqual(
    (await store.listLlmRequests(session.id, { orphans: true })).map((row) => row.turnSeq),
    [null],
  );
  for (const { turnSeq, count } of await store.llmRequestCounts(session.id, 3))
    assert.equal(
      (await store.listLlmRequests(session.id, turnSeq === null ? { orphans: true } : { turnSeqs: [turnSeq] })).length,
      count,
    );
  const detail = await store.listLlmRequests(session.id, { turnSeqs: [3] });
  assert.equal(detail.length, 2);
  assert.deepEqual(detail[0]!.promptEnvelope, { system: "context", messages: [{ role: "user", content: "step 2" }] });
  assert.equal(detail[0]!.usage?.costUsd, 0.01);
  assert.equal((await store.listLlmRequests(session.id, { omitRequest: true })).length, turnSeqs.length);
}
