import { test, before } from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryAmbientJudgmentStore,
  createPostgresAmbientJudgmentStore,
  type AmbientJudgmentStore,
} from "../src/surface-cache/ambient-judgment-store.ts";

const URL = process.env.DATABASE_URL;
const pgSkip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres ambient-judgment tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS ambient_judgments CASCADE");
  await p.end();
});

async function contract(store: AmbientJudgmentStore): Promise<void> {
  await store.record({
    surface: "slack",
    container: "C1",
    decision: "act",
    reason: "someone asked",
    askedBy: "2.0",
    prompt: "PROMPT-A",
    model: "claude-haiku-4-5",
    latencyMs: 42,
    tsFrom: "1.0",
    tsTo: "3.0",
    createdAt: 100,
  });
  await store.record({ surface: "slack", container: "C1", decision: "ignore", prompt: "PROMPT-B", createdAt: 200 });
  await store.record({ surface: "slack", container: "C2", decision: "fastlane", createdAt: 300 });

  const all = await store.list();
  assert.equal(all.length, 3);
  assert.equal(all[0]!.createdAt, 300, "newest first");

  const c1 = await store.list({ container: "C1" });
  assert.equal(c1.length, 2, "container filter");
  const act = c1.find((j) => j.decision === "act")!;
  assert.equal((act as { prompt?: string }).prompt, undefined, "list omits the heavy prompt");
  assert.equal(act.model, "claude-haiku-4-5");
  assert.equal(act.latencyMs, 42);
  assert.equal(act.askedBy, "2.0");
  assert.equal(act.tsFrom, "1.0");
  assert.equal(act.tsTo, "3.0");

  const detail = await store.get(act.id!);
  assert.equal(detail!.prompt, "PROMPT-A");
  assert.equal(detail!.askedBy, "2.0");

  const judged = await store.list({ decision: ["act", "ignore"] });
  assert.deepEqual(judged.map((j) => j.decision).sort(), ["act", "ignore"], "decision filter excludes fastlane");

  const before = await store.list({ before: 300 });
  assert.deepEqual(
    before.map((j) => j.createdAt),
    [200, 100],
    "before cursor pages older",
  );

  const counts = await store.counts();
  assert.deepEqual(counts, { act: 1, ignore: 1, fastlane: 1 });
  assert.deepEqual(
    await store.counts({ container: "C1" }),
    { act: 1, ignore: 1, fastlane: 0 },
    "counts respect container",
  );

  const one = await store.list({ limit: 1 });
  assert.equal(one.length, 1);

  await store.record({ surface: "slack", container: "C9", decision: "ignore", createdAt: 500 });
  await store.record({ surface: "slack", container: "C9", decision: "ignore", createdAt: 500 });
  const tieHead = await store.list({ container: "C9", limit: 1 });
  assert.equal(tieHead.length, 1);
  const tieNext = await store.list({
    container: "C9",
    before: tieHead[0]!.createdAt,
    beforeId: tieHead[0]!.id,
    limit: 1,
  });
  assert.equal(tieNext.length, 1, "the tied sibling is not skipped");
  assert.notEqual(tieNext[0]!.id, tieHead[0]!.id, "and it's a distinct row");
}

test("memory ambient-judgment store: record + list contract", async () => {
  const store = createMemoryAmbientJudgmentStore();
  await contract(store);
  await store.close();
});

test("memory ambient-judgment store: bounded at 5000 rows", async () => {
  const store = createMemoryAmbientJudgmentStore();
  for (let i = 0; i < 5010; i++)
    await store.record({ surface: "slack", container: "C1", decision: "ignore", createdAt: i });
  const all = await store.list({ limit: 1000 });
  assert.equal(all.length, 1000, "list caps at 1000");
  assert.equal(all[0]!.createdAt, 5009, "the most recent survived the bound");
  assert.equal(all.at(-1)!.createdAt, 4010, "older rows past the 5000-row bound were dropped");
});

test("pg ambient-judgment store: record + list contract", { skip: pgSkip }, async () => {
  const store = createPostgresAmbientJudgmentStore(URL!);
  await contract(store);
  await store.close();
});
