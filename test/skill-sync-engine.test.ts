import { test } from "node:test";
import assert from "node:assert/strict";
import { createSkillPackStore, type NewSkillPack } from "../src/skills/skill-pack-store.ts";
import { createSkillSyncEngine } from "../src/skills/skill-sync-engine.ts";
import type { SkillPackFetcher } from "../src/skills/pack-fetcher.ts";

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

test("tracked pack: fast-path skips reconcile when HEAD == last good commit", async () => {
  const packs = createSkillPackStore();
  const s = await packs.create(base);
  await packs.recordImport(s.id, { at: 0, commit: "c1", status: "ok" });
  const calls: string[] = [];
  const engine = createSkillSyncEngine({
    packs,
    fetcher: fakeFetcher({ [s.id]: "c1" }),
    reconcile: async (id) => void calls.push(id),
  });
  await engine.tick();
  assert.deepEqual(calls, [], "an unchanged tracked pack is not reconciled (no full clone)");
});

test("tracked pack: reconciles when HEAD has advanced", async () => {
  const packs = createSkillPackStore();
  const s = await packs.create(base);
  await packs.recordImport(s.id, { at: 0, commit: "c1", status: "ok" });
  const calls: string[] = [];
  const engine = createSkillSyncEngine({
    packs,
    fetcher: fakeFetcher({ [s.id]: "c2" }),
    reconcile: async (id) => void calls.push(id),
  });
  await engine.tick();
  assert.deepEqual(calls, [s.id], "an advanced tracked pack is reconciled");
});

test("pinned pack: sets updateAvailable when the line advanced past the pinned commit", async () => {
  const packs = createSkillPackStore();
  const s = await packs.create({ ...base, syncMode: "pinned", ref: "c1" });
  await packs.recordImport(s.id, { at: 0, commit: "c1", status: "ok" });
  const calls: string[] = [];
  const engine = createSkillSyncEngine({
    packs,
    fetcher: fakeFetcher({ [s.id]: "c2" }),
    reconcile: async (id) => void calls.push(id),
  });
  await engine.tick();
  assert.equal((await packs.get(s.id))?.updateAvailable, true, "pinned + advanced ⇒ update available");
  assert.deepEqual(calls, [], "a pinned pack is never auto-reconciled");
});

test("pinned pack: clears a stale updateAvailable when HEAD == pinned commit", async () => {
  const packs = createSkillPackStore();
  const s = await packs.create({ ...base, syncMode: "pinned", ref: "c1" });
  await packs.recordImport(s.id, { at: 0, commit: "c1", status: "ok" });
  await packs.update(s.id, { updateAvailable: true });
  const engine = createSkillSyncEngine({ packs, fetcher: fakeFetcher({ [s.id]: "c1" }), reconcile: async () => {} });
  await engine.tick();
  assert.equal((await packs.get(s.id))?.updateAvailable, false, "no advance ⇒ flag cleared");
});

test("one failing pack never aborts the tick", async () => {
  const packs = createSkillPackStore();
  const bad = await packs.create(base);
  await packs.recordImport(bad.id, { at: 0, commit: "c1", status: "ok" });
  const good = await packs.create(base);
  await packs.recordImport(good.id, { at: 0, commit: "c1", status: "ok" });
  const calls: string[] = [];
  const engine = createSkillSyncEngine({
    packs,
    fetcher: fakeFetcher({ [good.id]: "c2" }),
    reconcile: async (id) => void calls.push(id),
  });
  await engine.tick();
  assert.deepEqual(calls, [good.id], "the healthy pack is still reconciled despite the failing one");
});
