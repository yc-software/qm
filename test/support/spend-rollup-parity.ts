import assert from "node:assert/strict";
import { scopeId, type SessionType } from "../../src/types.ts";
import type { SessionStore, SpendRow } from "../../src/sessions/session-store.ts";

const DAY = 86_400_000;
const BASE = Date.UTC(2021, 0, 1);

export async function assertSpendRollupParity(
  makeStore: (now: () => number) => SessionStore,
  prefix: string,
): Promise<void> {
  const clock = { at: BASE + 6 * 3_600_000 };
  const store = makeStore(() => clock.at);
  const alice = scopeId("personal", `${prefix}-alice`);
  const bob = scopeId("personal", `${prefix}-bob`);
  const channel = scopeId("channel", `${prefix}-C1`);
  const mine = new Set<string>([alice, bob, channel]);

  const record = async (
    threadRef: string,
    type: SessionType,
    scope: string,
    costUsd: number | null,
    model = "mock",
  ) => {
    const session = await store.getOrCreateByThread(threadRef, type, scope);
    await store.recordLlmRequest(session.id, {
      turnSeq: null,
      step: 0,
      model,
      scopeLabel: scope,
      usage:
        costUsd === null ? null : { input: 100, output: 20, cacheRead: 400, cacheWrite: 40, totalTokens: 560, costUsd },
    });
    return session;
  };

  await record(`${prefix}:alice-live-a`, "dm", alice, 1.5);
  await record(`${prefix}:alice-live-b`, "dm", alice, 0.25);
  await record(`${prefix}:alice-live-a`, "dm", alice, 0.75, "other-model");
  await record(`${prefix}:channel-live`, "channel", channel, 2);
  await record(`cron:${prefix}-nightly:fire:aaa`, "dm", alice, 0.5);
  clock.at += DAY;
  await record(`${prefix}:alice-live-c`, "dm", alice, 0.125);
  await record(`${prefix}:bob-live`, "dm", bob, 4);
  await record(`${prefix}:bob-unpriced`, "dm", bob, null);
  clock.at += DAY;
  await record(`${prefix}:alice-out-of-window`, "dm", alice, 8);

  await store.recordLlmRequest(`${prefix}-orphan-session`, {
    turnSeq: null,
    step: 0,
    model: "mock",
    scopeLabel: alice,
    usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, totalTokens: 4, costUsd: 99 },
  });

  const day = Math.floor(BASE / DAY);
  const rollup = (await store.spendRollup({ from: BASE, to: BASE + 2 * DAY })).filter((r) => mine.has(r.scopeId));
  const key = (r: SpendRow) => JSON.stringify([r.day, r.scopeId, r.origin, r.model]);
  const byKey = (a: SpendRow, b: SpendRow) => {
    if (key(a) === key(b)) return 0;
    return key(a) < key(b) ? -1 : 1;
  };
  const sorted = [...rollup].sort(byKey);

  const expected: SpendRow[] = (
    [
      {
        day,
        scopeId: alice,
        model: "other-model",
        origin: "conversation",
        calls: 1,
        costUsd: 0.75,
        input: 100,
        output: 20,
        cacheRead: 400,
        cacheWrite: 40,
      },
      {
        day,
        scopeId: alice,
        model: "mock",
        origin: "conversation",
        calls: 2,
        costUsd: 1.75,
        input: 200,
        output: 40,
        cacheRead: 800,
        cacheWrite: 80,
      },
      {
        day,
        scopeId: alice,
        model: "mock",
        origin: "cron",
        calls: 1,
        costUsd: 0.5,
        input: 100,
        output: 20,
        cacheRead: 400,
        cacheWrite: 40,
      },
      {
        day,
        scopeId: channel,
        model: "mock",
        origin: "conversation",
        calls: 1,
        costUsd: 2,
        input: 100,
        output: 20,
        cacheRead: 400,
        cacheWrite: 40,
      },
      {
        day: day + 1,
        scopeId: alice,
        model: "mock",
        origin: "conversation",
        calls: 1,
        costUsd: 0.125,
        input: 100,
        output: 20,
        cacheRead: 400,
        cacheWrite: 40,
      },
      {
        day: day + 1,
        scopeId: bob,
        model: "mock",
        origin: "conversation",
        calls: 1,
        costUsd: 4,
        input: 100,
        output: 20,
        cacheRead: 400,
        cacheWrite: 40,
      },
    ] satisfies SpendRow[]
  ).sort(byKey);

  assert.deepEqual(sorted, expected);

  clock.at = BASE;
  const child = async (name: string, parentId: string) => {
    const session = await record(`agent:main:subagent:${prefix}-${name}`, "dm", alice, 0.01, `${prefix}-${name}`);
    await store.setParentSession(session.id, parentId);
    return session;
  };
  for (const origin of ["cron", "webhook", "monitor", "conversation"] as const) {
    const parent = await store.getOrCreateByThread(`agent:main:${origin}:${prefix}-parent`, "dm", bob);
    const first = await child(`${origin}-child`, parent.id);
    await child(`${origin}-grandchild`, first.id);
  }
  await child("missing-parent", `${prefix}-missing`);
  const deleted = await store.getOrCreateByThread(`cron:${prefix}-deleted`, "dm", bob);
  await child("deleted-parent", deleted.id);
  await store.deleteSession(deleted.id);
  const cycleA = await child("cycle-a", `${prefix}-missing`);
  const cycleB = await child("cycle-b", cycleA.id);
  await store.setParentSession(cycleA.id, cycleB.id);
  const self = await child("self-cycle", `${prefix}-missing`);
  await store.setParentSession(self.id, self.id);

  const inherited = (await store.spendRollup({ from: BASE, to: BASE + DAY })).filter((r) =>
    r.model?.startsWith(`${prefix}-`),
  );
  const origins = new Map<string, string>([
    ...["cron", "webhook", "monitor", "conversation"].flatMap((origin) =>
      ["child", "grandchild"].map((kind) => [`${prefix}-${origin}-${kind}`, origin] as const),
    ),
    ...["missing-parent", "deleted-parent", "cycle-a", "cycle-b", "self-cycle"].map(
      (name) => [`${prefix}-${name}`, "conversation"] as const,
    ),
  ]);
  assert.equal(inherited.length, origins.size);
  for (const row of inherited) {
    assert.equal(row.origin, origins.get(row.model!), row.model!);
    assert.equal(row.scopeId, alice, "inherit origin, not the parent's scope");
    assert.equal(row.calls, 1);
    assert.equal(row.costUsd, 0.01);
  }

  clock.at = BASE + 123;
  const changing = await record(`${prefix}:changing`, "dm", alice, 0, `${prefix}-changing`);
  const range = { from: clock.at, to: clock.at + 1 };
  const readChanging = async () => (await store.spendRollup(range)).filter((r) => r.model === `${prefix}-changing`);
  assert.equal((await readChanging())[0]!.calls, 1);
  assert.equal((await readChanging())[0]!.costUsd, 0);
  assert.equal(
    (await store.spendRollup({ from: BASE, to: clock.at })).some((r) => r.model === `${prefix}-changing`),
    false,
  );
  await record(`${prefix}:changing`, "dm", alice, 2, `${prefix}-changing`);
  assert.equal((await readChanging())[0]!.calls, 2);
  assert.equal((await readChanging())[0]!.costUsd, 2);
  const cronParent = await store.getOrCreateByThread(`cron:${prefix}-changing:fire:aaa`, "dm", bob);
  await store.setParentSession(changing.id, cronParent.id);
  assert.equal((await readChanging())[0]!.origin, "cron");
  await store.deleteSession(cronParent.id);
  assert.equal((await readChanging())[0]!.origin, "conversation");
  await store.deleteSession(changing.id);
  assert.deepEqual(await readChanging(), []);
}
