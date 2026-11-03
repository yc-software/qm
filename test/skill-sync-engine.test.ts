import { test } from "node:test";
import assert from "node:assert/strict";
import { type NewSkillPack } from "../src/skills/skill-pack-store.ts";
import { createSkillSyncEngine } from "../src/skills/skill-sync-engine.ts";
import type { SkillPackFetcher } from "../src/skills/pack-fetcher.ts";
import { boundTenant, withoutTenant } from "../src/tenants/context.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { testSkillPackStore } from "./support/typed-stores.ts";
import { inTestTenant, testTenants } from "./support/test-tenants.ts";

const base: NewSkillPack = {
  kind: "git",
  url: "u",
  ref: "main",
  syncMode: "tracked",
  trustTier: "internal",
  targetScopeId: "org:acme",
  subset: "all",
  createdBy: "u",
};

function packsWithDeps() {
  const url = testDatabaseUrl();
  return { packs: testSkillPackStore({}, url), deps: singleProcessDeps(url) };
}

function fakeFetcher(headBySource: Record<string, string>): SkillPackFetcher {
  return {
    fetch: () => {
      throw new Error("the engine must not full-clone directly");
    },
    resolveRef: async (s) => {
      const h = headBySource[s.id];
      if (h === undefined) throw new Error(`no head for ${s.id}`);
      return h;
    },
  };
}

test("tracked pack: fast-path skips reconcile when HEAD == last good commit", () =>
  inTestTenant(async () => {
    const { packs, deps } = packsWithDeps();
    const s = await packs.create(base);
    await packs.recordImport(s.id, { at: 0, commit: "c1", status: "ok" });
    const calls: string[] = [];
    const engine = createSkillSyncEngine({
      ...deps,
      packs,
      fetcher: fakeFetcher({ [s.id]: "c1" }),
      reconcile: async (id) => void calls.push(id),
    });
    await withoutTenant(() => engine.tick());
    assert.deepEqual(calls, [], "an unchanged tracked pack is not reconciled (no full clone)");
  }));

test("tracked pack: reconciles when HEAD has advanced", () =>
  inTestTenant(async () => {
    const { packs, deps } = packsWithDeps();
    const s = await packs.create(base);
    await packs.recordImport(s.id, { at: 0, commit: "c1", status: "ok" });
    const calls: string[] = [];
    const engine = createSkillSyncEngine({
      ...deps,
      packs,
      fetcher: fakeFetcher({ [s.id]: "c2" }),
      reconcile: async (id) => void calls.push(id),
    });
    await withoutTenant(() => engine.tick());
    assert.deepEqual(calls, [s.id], "an advanced tracked pack is reconciled");
  }));

test("pinned pack: sets updateAvailable when the line advanced past the pinned commit", () =>
  inTestTenant(async () => {
    const { packs, deps } = packsWithDeps();
    const s = await packs.create({ ...base, syncMode: "pinned", ref: "c1" });
    await packs.recordImport(s.id, { at: 0, commit: "c1", status: "ok" });
    const calls: string[] = [];
    const engine = createSkillSyncEngine({
      ...deps,
      packs,
      fetcher: fakeFetcher({ [s.id]: "c2" }),
      reconcile: async (id) => void calls.push(id),
    });
    await withoutTenant(() => engine.tick());
    assert.equal((await packs.get(s.id))?.updateAvailable, true, "pinned + advanced ⇒ update available");
    assert.deepEqual(calls, [], "a pinned pack is never auto-reconciled");
  }));

test("pinned pack: clears a stale updateAvailable when HEAD == pinned commit", () =>
  inTestTenant(async () => {
    const { packs, deps } = packsWithDeps();
    const s = await packs.create({ ...base, syncMode: "pinned", ref: "c1" });
    await packs.recordImport(s.id, { at: 0, commit: "c1", status: "ok" });
    await packs.update(s.id, { updateAvailable: true });
    const engine = createSkillSyncEngine({
      ...deps,
      packs,
      fetcher: fakeFetcher({ [s.id]: "c1" }),
      reconcile: async () => {},
    });
    await withoutTenant(() => engine.tick());
    assert.equal((await packs.get(s.id))?.updateAvailable, false, "no advance ⇒ flag cleared");
  }));

test("one failing pack never aborts the tick", () =>
  inTestTenant(async () => {
    const { packs, deps } = packsWithDeps();
    const bad = await packs.create(base);
    await packs.recordImport(bad.id, { at: 0, commit: "c1", status: "ok" });
    const good = await packs.create(base);
    await packs.recordImport(good.id, { at: 0, commit: "c1", status: "ok" });
    const calls: string[] = [];
    const engine = createSkillSyncEngine({
      ...deps,
      packs,
      fetcher: fakeFetcher({ [good.id]: "c2" }),
      reconcile: async (id) => void calls.push(id),
    });
    await withoutTenant(() => engine.tick());
    assert.deepEqual(calls, [good.id], "the healthy pack is still reconciled despite the failing one");
  }));

test("one tick syncs every tenant's packs, each under its own tenant", async () => {
  const [tenant, otherTenant] = testTenants();
  const { packs, deps } = packsWithDeps();
  const ids = new Map<string, string>();
  for (const id of [tenant, otherTenant]) {
    const pack = await inTestTenant(() => packs.create(base), id);
    await inTestTenant(() => packs.recordImport(pack.id, { at: 0, commit: "c1", status: "ok" }), id);
    ids.set(pack.id, id);
  }
  const reconciled = new Map<string, string | undefined>();
  const engine = createSkillSyncEngine({
    ...deps,
    packs,
    fetcher: fakeFetcher(Object.fromEntries([...ids.keys()].map((id) => [id, "c2"]))),
    reconcile: async (id) => void reconciled.set(id, boundTenant()),
  });
  await withoutTenant(() => engine.tick());
  assert.deepEqual(reconciled, ids);
});
