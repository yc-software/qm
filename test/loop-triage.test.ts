import assert from "node:assert/strict";
import { test } from "node:test";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { sortLedgerItems } from "../src/loops/ledger-view.ts";
import { planTriage, removeFromGroup, settleGroup, triageWork, workOrder } from "../src/loops/triage.ts";
import { scopeId, type Loop, type LoopItem } from "../src/types.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { sleep } from "../src/util/async.ts";

const LOOP = "loop-1";

async function flood() {
  const ledger = createLoopItemLedger();
  const loop = (
    await createLoopStore().create({
      owner: "U1",
      createdBy: "U1",
      ownerScopeId: scopeId("personal", "U1"),
      name: "Sentry",
      playbook: "fix",
      successCondition: "fixed",
    })
  ).loop;
  const triaged: Loop = {
    ...loop,
    id: LOOP,
    triage: { prioritize: { enabled: true }, consolidate: { enabled: true } },
  };
  for (const [index, key] of ["a", "b", "c", "d"].entries()) {
    await ledger.ingest([{ loopId: LOOP, dedupeKey: key, sourcePayload: { title: key }, sourceAt: 100 + index }]);
    await sleep(2);
  }
  const ids = Object.fromEntries((await ledger.byLoop(LOOP)).map((item) => [item.sourceKey, item.id]));
  return { ledger, loop: triaged, ids };
}

async function triage(s: Awaited<ReturnType<typeof flood>>, decisions: Parameters<typeof planTriage>[3]) {
  const work = triageWork(s.loop, await s.ledger.byLoop(LOOP));
  if (!work) return;
  for (const [id, patch] of planTriage(s.loop, work.open, work.pending, decisions))
    await s.ledger.setTriage(id, patch, "agent");
}

test("triage groups into one representative, sorts by priority, and leaves triaged items alone", async () => {
  const s = await flood();
  const { a, b, c, d } = s.ids as Record<string, string>;
  await triage(s, [
    { id: a!, priority: "low" },
    { id: b!, priority: "urgent", reason: "outage", groupWith: c! },
    { id: c!, priority: "high" },
    { id: d!, priority: "normal", groupWith: b! },
  ]);
  const items = await s.ledger.byLoop(LOOP);
  const groups = new Set(items.map((item) => item.triage?.groupId));
  assert.deepEqual([...groups].sort(), [b, undefined].sort());
  assert.deepEqual(
    sortLedgerItems(items, s.loop).map((item) => item.sourceKey),
    ["b", "c", "d", "a"],
  );
  assert.deepEqual(
    sortLedgerItems(items, {}).map((item) => item.sourceKey),
    ["d", "c", "b", "a"],
  );
  assert.equal(triageWork(s.loop, items), null);
});

test("human priority and group overrides survive later triage runs", async () => {
  const s = await flood();
  const { a, b, c } = s.ids as Record<string, string>;
  await triage(s, [
    { id: a!, priority: "low", groupWith: b! },
    { id: c!, priority: "low", groupWith: b! },
  ]);
  await s.ledger.setTriage(a!, { priority: "urgent" }, "human");
  await removeFromGroup(s.ledger, (await s.ledger.get(b!))!);
  const promoted = (await s.ledger.get(a!))!.triage?.groupId;
  assert.ok(promoted);
  assert.equal((await s.ledger.get(c!))!.triage?.groupId, promoted);
  await s.ledger.ingest([{ loopId: LOOP, dedupeKey: "b", sourcePayload: { title: "b" }, sourceAt: 500 }]);
  await s.ledger.ingest([{ loopId: LOOP, dedupeKey: "a", sourcePayload: { title: "a" }, sourceAt: 500 }]);
  await triage(s, [
    { id: a!, priority: "low" },
    { id: b!, priority: "low", groupWith: c! },
  ]);
  assert.equal((await s.ledger.get(a!))!.triage?.priority, "urgent");
  assert.equal((await s.ledger.get(b!))!.triage?.groupId, undefined);
});

test("resolving a representative resolves its open members without touching their sources", async () => {
  const s = await flood();
  const { a, b, c } = s.ids as Record<string, string>;
  await triage(s, [
    { id: b!, groupWith: a! },
    { id: c!, groupWith: a! },
  ]);
  const representative = await s.ledger.recordAction(a!, { kind: "dismiss", outcome: "dismissed" });
  await settleGroup(s.ledger, representative!);
  for (const id of [b!, c!]) {
    const member = (await s.ledger.get(id))!;
    assert.equal(member.status, "skipped");
    assert.equal(member.actionKind, "consolidated");
    assert.deepEqual(member.sourcePayload, { title: member.sourceKey });
  }
  assert.equal((await s.ledger.get(s.ids.d!))!.status, "queued");
});

test("members of a representative resolved elsewhere are released for work and fresh triage", async () => {
  const s = await flood();
  const { a, b, c } = s.ids as Record<string, string>;
  await triage(s, [
    { id: b!, groupWith: a! },
    { id: c!, groupWith: a! },
  ]);
  assert.deepEqual(
    workOrder(s.loop, await s.ledger.queued(LOOP), await s.ledger.byLoop(LOOP)).map((item) => item.sourceKey),
    ["a", "d"],
  );
  await s.ledger.recordAction(a!, { kind: "replied", outcome: "dismissed" });
  const items = await s.ledger.byLoop(LOOP);
  assert.deepEqual(
    workOrder(s.loop, await s.ledger.queued(LOOP), items).map((item) => item.sourceKey),
    ["b", "c", "d"],
  );
  assert.deepEqual(
    triageWork(s.loop, items)
      ?.pending.map((item) => item.sourceKey)
      .sort(),
    ["b", "c"],
  );
  await triage(s, [{ id: c!, groupWith: b! }]);
  assert.equal((await s.ledger.get(c!))!.triage?.groupId, b);
});

test("regrouping moves only the item and hands its old group to the oldest remaining member", () => {
  const item = (id: string, createdAt: number, groupId?: string): LoopItem => ({
    id,
    loopId: LOOP,
    sourceKey: id,
    status: "queued",
    attempts: 0,
    runIds: [],
    outputIds: [],
    createdAt,
    updatedAt: createdAt,
    triage: { at: createdAt, ...(groupId ? { groupId } : {}) },
  });
  const open = [item("a", 1, "a"), item("b", 2, "a"), item("c", 3, "a"), item("d", 4)];
  const loop = { triage: { consolidate: { enabled: true } } };
  const plan = planTriage(loop, open, [open[0]!], [{ id: "a", groupWith: "d" }]);
  assert.deepEqual(
    Object.fromEntries(
      ["a", "b", "c", "d"].map((id) => [id, plan.get(id)?.groupId ?? open.find((i) => i.id === id)!.triage!.groupId]),
    ),
    { a: "a", b: "b", c: "b", d: "a" },
  );
});
