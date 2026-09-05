import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createCachedSkillPackFetcher, type SkillPackSourceSnapshot } from "../src/skills/pack-source-cache.ts";
import type { SkillPack } from "../src/skills/skill-pack-store.ts";
import type { FetchedRepo } from "../src/skills/ingest.ts";

const pack: SkillPack = {
  id: "source-test",
  kind: "git",
  url: "https://example.com/skills",
  ref: "main",
  createdBy: "admin",
  createdAt: 1,
  syncMode: "pinned",
  trustTier: "third-party",
  subset: "all",
  targetScopeId: "org:test",
};
const repo = (commit: string): FetchedRepo => ({
  commit,
  files: [{ path: "SKILL.md", text: "# skill", binary: false }],
});

test("reuses downloaded snapshots across fetchers and locks import to the previewed commit", async () => {
  const snapshots = createMemoryMap<SkillPackSourceSnapshot>();
  let calls = 0;
  let now = 100;
  const git = { fetch: async () => repo(String(++calls).repeat(40)), resolveRef: async () => "1".repeat(40) };
  const first = createCachedSkillPackFetcher({ git, snapshots, now: () => now, ttlMs: 10 });
  const one = await first.fetch(pack);
  const restarted = createCachedSkillPackFetcher({ git, snapshots, now: () => now, ttlMs: 10 });
  assert.deepEqual(await restarted.fetch(pack), one);
  assert.equal(calls, 1);
  now += 100;
  assert.deepEqual(await restarted.fetch(pack, { expectedCommit: one.commit }), one);
  assert.equal(calls, 1);
  const two = await restarted.fetch(pack);
  assert.equal(calls, 2);
  assert.notEqual(two.commit, one.commit);
  assert.deepEqual(await restarted.fetch(pack, { expectedCommit: one.commit }), one);
  await assert.rejects(restarted.fetch(pack, { expectedCommit: "f".repeat(40) }), /preview expired/);
});

test("never reuses a snapshot after source or credential identity changes", async () => {
  let calls = 0;
  const source = createCachedSkillPackFetcher({
    snapshots: createMemoryMap(),
    git: { fetch: async () => repo(String(++calls).repeat(40)), resolveRef: async () => "" },
  });
  const first = await source.fetch(pack);
  await assert.rejects(
    source.fetch({ ...pack, url: "https://example.com/other" }, { expectedCommit: first.commit }),
    /preview expired/,
  );
  await source.fetch({ ...pack, authCredentialSlug: "new-token" });
  await source.fetch({ ...pack, createdBy: "other-admin" });
  await source.fetch({ ...pack, ref: "other-branch" });
  assert.equal(calls, 4);
});

test("a failed forced refresh preserves the previous snapshot but does not report success", async () => {
  let fail = false;
  const source = createCachedSkillPackFetcher({
    snapshots: createMemoryMap(),
    git: {
      fetch: async () => {
        if (fail) throw new Error("offline");
        return repo("a".repeat(40));
      },
      resolveRef: async () => "",
    },
  });
  const original = await source.fetch(pack);
  fail = true;
  await assert.rejects(source.fetch(pack, { refresh: true }), /offline/);
  assert.deepEqual(await source.fetch(pack, { expectedCommit: original.commit }), original);
});

test("deduplicates concurrent downloads and retries after failures", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const source = createCachedSkillPackFetcher({
    snapshots: createMemoryMap(),
    git: {
      fetch: async () => {
        calls++;
        await gate;
        return repo("a".repeat(40));
      },
      resolveRef: async () => "",
    },
  });
  const a = source.fetch(pack);
  const b = source.fetch(pack);
  release();
  assert.deepEqual(await a, await b);
  assert.equal(calls, 1);
});

test("offline packs survive reconstruction, retain one previous upload and never call Git", async () => {
  const snapshots = createMemoryMap<SkillPackSourceSnapshot>();
  const git = {
    fetch: async () => {
      throw new Error("Git must not run");
    },
    resolveRef: async () => {
      throw new Error("Git must not run");
    },
  };
  const archive = { ...pack, kind: "archive" as const, ref: "a".repeat(64), url: "pack.zip" };
  const first = createCachedSkillPackFetcher({ snapshots, git });
  await first.storeArchive!(archive, repo(archive.ref));
  const restarted = createCachedSkillPackFetcher({ snapshots, git });
  assert.equal((await restarted.fetch(archive)).commit, archive.ref);
  assert.equal(await restarted.resolveRef(archive), archive.ref);
  const next = { ...archive, ref: "b".repeat(64), url: "new.zip" };
  await restarted.storeArchive!(next, repo(next.ref));
  assert.equal((await restarted.fetch(next)).commit, next.ref);
  assert.equal((await restarted.fetch(archive)).commit, archive.ref);
  await assert.rejects(restarted.fetch(next, { expectedCommit: archive.ref }), /version changed/);
  await restarted.remove!(archive);
  await assert.rejects(restarted.fetch(archive), /unavailable/);
});
