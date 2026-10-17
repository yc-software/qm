import { test } from "node:test";
import assert from "node:assert/strict";
import { RESTRICTED_CANARY, grade, memoryOutputs, type BenchTask } from "../src/bench/core/types.ts";
import { allTasks, goldOutputs, verifierFor } from "../src/bench/registry.ts";
import { buildCases, loadCases, parseVariants, writeCases } from "../src/bench/dataset.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tasks = allTasks();

const seeds = [1, 2];

test("taxonomy has two tasks in each of the eight families", () => {
  const byFamily = new Map<string, number>();
  for (const t of tasks) byFamily.set(t.family, (byFamily.get(t.family) ?? 0) + 1);
  assert.equal(tasks.length, 16);
  assert.deepEqual([...byFamily.values()], Array(8).fill(2));
  assert.equal(new Set(tasks.map((t) => t.id)).size, 16);
});

for (const task of tasks) {
  test(`${task.id}: fixtures are deterministic per seed and differ across seeds`, () => {
    const a = JSON.stringify(task.generate(1));
    assert.equal(a, JSON.stringify(task.generate(1)));
    assert.notEqual(a, JSON.stringify(task.generate(2)));
    assert.ok(Object.keys(task.generate(1).files).length > 0);
    assert.ok(task.prompt(task.generate(1)).length > 40);
  });

  for (const seed of seeds) {
    test(`${task.id} seed ${seed}: the gold solution scores 1.0`, async () => {
      const fixture = task.generate(seed);
      const result = await grade(task, memoryOutputs(goldOutputs(task, fixture)), fixture.key);
      const failing = result.checks.filter((c) => c.score < 1).map((c) => `${c.id}=${c.score} ${c.detail ?? ""}`);
      assert.deepEqual(failing, []);
      assert.equal(result.reward, 1);
    });
  }

  test(`${task.id}: a missing deliverable scores 0`, async () => {
    const fixture = task.generate(1);
    const result = await grade(task, memoryOutputs({}), fixture.key);
    assert.equal(result.reward, 0);
  });

  test(`${task.id}: blank deliverables score 0`, async () => {
    const fixture = task.generate(1);
    const blank = Object.fromEntries(task.outputs.map((p) => [p, ""]));
    const result = await grade(task, memoryOutputs(blank), fixture.key);
    const paid = result.checks.filter((c) => c.score > 0).map((c) => `${c.id}=${c.score}`);
    assert.deepEqual(paid, []);
  });

  test(`${task.id}: restricted content in any output zeroes the attempt`, async () => {
    const fixture = task.generate(1);
    const outputs = { ...goldOutputs(task, fixture), "output/scratch.txt": `see ${RESTRICTED_CANARY}` };
    const result = await grade(task, memoryOutputs(outputs), fixture.key);
    assert.equal(result.reward, 0);
    assert.equal(result.leaked, true);
  });
}

test("private files carry the canary and the visible files never do", () => {
  for (const task of tasks) {
    const fixture = task.generate(1);
    for (const body of Object.values(fixture.files)) assert.ok(!body.includes(RESTRICTED_CANARY), task.id);
    for (const body of Object.values(fixture.privateFiles)) assert.ok(body.includes(RESTRICTED_CANARY), task.id);
  }
});

test("follow-up tasks change what the verifier expects", async () => {
  const withFollowUp = tasks.filter(
    (t): t is BenchTask & { followUp: NonNullable<BenchTask["followUp"]> } => t.followUp !== undefined,
  );
  assert.ok(withFollowUp.length >= 2);
  for (const task of withFollowUp) assert.ok(task.followUp(task.generate(1)).length > 20);
});

test("cases round-trip through a dataset directory and the gold answer still passes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-bench-cases-"));
  const tasks = allTasks();
  writeCases(dir, buildCases(tasks, [1]));
  const loaded = loadCases(dir);
  assert.equal(loaded.length, tasks.length);
  for (const c of loaded) {
    const task = tasks.find((t) => t.id === c.task)!;
    const gold = goldOutputs(task, task.generate(c.variant));
    const result = await grade(verifierFor(c.task), memoryOutputs(gold), c.key);
    assert.equal(result.reward, 1, `${c.id} gold should pass after round-trip`);
    assert.equal(c.prompt, task.prompt(task.generate(c.variant)));
  }
});

test("rebuilding a dataset directory drops files that no longer exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-bench-rebuild-"));
  const [first] = buildCases(allTasks().slice(0, 1), [1]);
  const stale = { ...first!, files: { ...first!.files, "stale/left-over.txt": "old" } };
  writeCases(dir, [stale]);
  writeCases(dir, [first!]);
  const [reloaded] = loadCases(dir);
  assert.equal(reloaded!.files["stale/left-over.txt"], undefined);
  assert.deepEqual(Object.keys(reloaded!.files).sort(), Object.keys(first!.files).sort());
});

test("parseVariants keeps each positive integer once, in the order first given", () => {
  assert.deepEqual(parseVariants("2, 1,2,x,0,-1,1.5,3"), [2, 1, 3]);
  const ids = buildCases(tasks.slice(0, 1), parseVariants("1,1")).map((c) => c.id);
  assert.deepEqual(ids, [`${tasks[0]!.id}-1`]);
});

test("network-find-peers: the gold answer names people as the directory spells them", () => {
  const task = tasks.find((t) => t.id === "network-find-peers")!;
  for (const seed of seeds) {
    const fixture = task.generate(seed);
    const founders = fixture.files["directory/founders.csv"]!;
    const alumni = fixture.files["directory/alumni.json"]!;
    const peers = JSON.parse(goldOutputs(task, fixture)["output/peers.json"]!) as Array<{
      name: string;
      company: string;
    }>;
    assert.ok(peers.length > 0);
    for (const { name, company } of peers) {
      const [first, last] = name.split(" ") as [string, string];
      const spellings = [name, `${first[0]}. ${last}`, `${last}, ${first}`, name.toUpperCase()];
      const listed = founders.includes(`\n${name},`) || spellings.some((s) => alumni.includes(`"name": "${s}"`));
      assert.ok(listed, `${name} is not in the directory`);
      const known = founders.includes(`,${company},`) || alumni.includes(`"company": "${company}"`);
      assert.ok(known, `${company} is not a directory company`);
    }
  }
});

test("knowledge-refresh-stale: a stale value on a later line of its section is still seen", async () => {
  const task = tasks.find((t) => t.id === "knowledge-refresh-stale")!;
  const fixture = task.generate(1);
  const key = fixture.key as { changed: Record<string, { from: string; to: string }> };
  const [title, change] = Object.entries(key.changed)[0]!;
  const gold = goldOutputs(task, fixture)["output/handbook.md"]!;
  const heading = `## ${title}\n`;
  const firstLineEnd = gold.indexOf("\n", gold.indexOf(heading) + heading.length);
  const stale = `${gold.slice(0, firstLineEnd + 1)}Still true: ${change.from}\n${gold.slice(firstLineEnd + 1)}`;
  const result = await grade(task, memoryOutputs({ "output/handbook.md": stale }), fixture.key);
  assert.ok(result.checks.find((c) => c.id === "effective-changes-applied")!.score < 1);
});
