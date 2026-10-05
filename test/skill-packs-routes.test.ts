import "./support/auto-fake-sprites.ts";

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "x-admin-actor": "admin-alice@default-org", "content-type": "application/json" };
const json = async (r: Response): Promise<any> => r.json();
const md = (front: string) => `---\n${front}\n---\n# Body\ntext`;
const skillMd = (name: string, description = "d", scope = "company") =>
  md(`name: ${name}\ndescription: ${description}\nscope: ${scope}`);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function gitRepo(t: TestContext, files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "qm-pack-fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, env: GIT_ENV, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  const write = (next: Record<string, string>) => {
    for (const [path, content] of Object.entries(next)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  };
  const remove = (...paths: string[]) => {
    for (const path of paths) rmSync(join(dir, path), { recursive: true, force: true });
  };
  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  write(files);
  const sha = commit("init");
  return { dir, sha, write, remove, commit };
}

const skillFiles = (...names: string[]) =>
  Object.fromEntries(names.map((name) => [`skills/${name}/SKILL.md`, skillMd(name)]));

function fixtureRepo(t: TestContext) {
  return gitRepo(t, {
    "skills/reg-alpha/SKILL.md": skillMd("reg-alpha", "a"),
    "skills/reg-beta/SKILL.md": skillMd("reg-beta", "b"),
    "skills/reg-beta/scripts/x.py": "print(1)",
    "skills/reg-personal/SKILL.md": skillMd("reg-personal", "p", "personal"),
    "trusted/reg-secret/SKILL.md": skillMd("reg-secret", "s"),
    "lib/shared.mjs": "export const x = 1;",
    "skills/_conventions/quality.md": "# quality",
  });
}

function start(t: TestContext) {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "reg-routes-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    sessions: built.sessions,
    errors: built.errors,
  });
  server.listen(0);
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}/v1/admin/skill-packs${path}`, { method: "POST", headers: ADMIN, body: JSON.stringify(body) });
  const register = async (body: Record<string, unknown>) => (await json(await post("", body))).pack;
  const importPack = (id: string, body: Record<string, unknown> = { selected: "all" }) => post(`/${id}/import`, body);
  const importJson = async (id: string, body?: Record<string, unknown>) => json(await importPack(id, body));
  const getJson = async (path: string) => json(await fetch(`${base}/v1/admin${path}`, { headers: ADMIN }));
  const orgSkills = async (): Promise<any[]> => (await getJson("/skills?scope=org:default-org")).skills;
  const packs = async (): Promise<any[]> => (await getJson("/skill-packs")).packs;
  const remove = (id: string) => fetch(`${base}/v1/admin/skill-packs/${id}`, { method: "DELETE", headers: ADMIN });
  const packSkillsIn = async (scope: string, packId: string): Promise<string[]> =>
    (await getJson(`/skills?scope=${encodeURIComponent(scope)}`)).skills
      .filter((k: any) => k.status === "published" && k.ownerScopeId === scope && k.pack?.id === packId)
      .map((k: any) => k.name)
      .sort();
  return { base, built, post, register, importPack, importJson, getJson, orgSkills, packs, remove, packSkillsIn };
}

const EXCLUDE_TRUSTED = { config: { exclude: ["trusted/*"] } };
const BOTH_SCOPES = ["org:default-org", "personal:admin-alice"];

function gateBundlePut(s: ReturnType<typeof start>) {
  const originalPut = s.built.skillBundles.put.bind(s.built.skillBundles);
  const { promise: bundleEntered, resolve: entered } = Promise.withResolvers<void>();
  const { promise: bundleRelease, resolve: release } = Promise.withResolvers<void>();
  s.built.skillBundles.put = async (bundle) => {
    entered();
    await bundleRelease;
    await originalPut(bundle);
  };
  return { entered: bundleEntered, release };
}

test("register → browse → import → list → remove a git skill pack (org scope)", async (t) => {
  const repo = fixtureRepo(t);
  const s = start(t);
  const pack = await s.register({ url: repo.dir, ref: repo.sha, ...EXCLUDE_TRUSTED });
  const id = pack.id as string;
  assert.ok(id);
  assert.equal(pack.targetScopeId, "org:default-org");
  assert.equal(pack.syncMode, "pinned");
  assert.equal(pack.available, 2, "registration scans the repo so the available (eligible) count shows immediately");

  const cat = await s.getJson(`/skill-packs/${id}/catalog`);
  assert.equal(cat.counts.eligible, 2);
  assert.equal(cat.counts.scope, 1);
  assert.ok(!cat.candidates.some((c: any) => c.upstreamName === "reg-secret"));
  assert.ok(
    !cat.candidates.some((c: any) => (c.importedScopes || []).length),
    "nothing is imported anywhere before importing",
  );

  assert.deepEqual((await s.importJson(id)).imported.sort(), ["reg-alpha", "reg-beta"]);

  const cat2 = await s.getJson(`/skill-packs/${id}/catalog`);
  assert.deepEqual(
    cat2.candidates.find((c: any) => c.upstreamName === "reg-alpha")?.importedScopes,
    ["org:default-org"],
    "an imported skill reports the scope it landed in on re-browse",
  );

  const bundle = await s.built.skillBundles.get(id);
  assert.deepEqual(
    (bundle?.files ?? []).map((f) => f.path).sort(),
    ["lib/shared.mjs", "skills/_conventions/quality.md"],
    "shared files bundled; per-skill scripts + trusted/* excluded",
  );

  const alpha = (await s.orgSkills()).find((k: any) => k.name === "reg-alpha");
  assert.ok(alpha, "imported skill is listed");
  assert.equal(alpha.status, "published");
  assert.equal(alpha.ownerScopeId, "org:default-org");

  const list = await s.packs();
  assert.equal(list.length, 1);
  assert.equal(list[0].lastImport.status, "ok");
  assert.equal(list[0].importedCount, 2, "2 skills currently imported from this pack");
  assert.equal(list[0].lastImport.counts.eligible, 2, "available (eligible) count is on lastImport.counts");

  assert.equal((await json(await s.remove(id))).removed, 2);
  assert.equal((await s.packs()).length, 0);
  assert.equal(await s.built.skillBundles.get(id), null, "removing the pack deletes its shared bundle too");
});

test("register works with only a url (defaults to the repo's default branch)", async (t) => {
  const repo = fixtureRepo(t);
  const s = start(t);
  const pack = await s.register({ url: repo.dir, ...EXCLUDE_TRUSTED });
  assert.ok(pack.id);
  assert.equal(pack.ref, "");
  assert.deepEqual((await s.importJson(pack.id)).imported.sort(), ["reg-alpha", "reg-beta"]);
});

test("a legacy published skill with an unsafe name does not block unrelated pack reconciliation", async (t) => {
  const repo = fixtureRepo(t);
  const s = start(t);
  const legacy = await s.built.skills.create({
    scopeId: "org:default-org",
    manifest: { name: "legacy-safe", description: "legacy", requiredCapabilities: [], body: "legacy" },
    createdBy: "legacy-import",
  });
  await s.built.skills.review(legacy.id, "reviewer", []);
  await s.built.skills.publish(legacy.id);
  legacy.manifest.name = "Legacy Skill";

  const pack = await s.register({ url: repo.dir, ref: repo.sha });
  const imported = await s.importPack(pack.id, { selected: ["reg-alpha"] });
  assert.equal(imported.status, 200);
  assert.deepEqual((await json(imported)).imported, ["reg-alpha"]);
});

test("supporting files are namespaced per pack, so same paths never clobber", async (t) => {
  const sharedLibRepo = (skillName: string) =>
    gitRepo(t, { ...skillFiles(skillName), "lib/shared.mjs": `export const who = "${skillName}";` });
  const a = sharedLibRepo("col-alpha");
  const b = sharedLibRepo("col-beta");
  const s = start(t);
  const idA = (await s.register({ url: a.dir, ref: a.sha })).id as string;
  await s.importPack(idA);
  const idB = (await s.register({ url: b.dir, ref: b.sha })).id as string;
  assert.equal((await s.importPack(idB)).status, 200);

  assert.equal(
    (await s.built.skillBundles.get(idA))?.files.find((f) => f.path === "lib/shared.mjs")?.content,
    'export const who = "col-alpha";',
  );
  assert.equal(
    (await s.built.skillBundles.get(idB))?.files.find((f) => f.path === "lib/shared.mjs")?.content,
    'export const who = "col-beta";',
  );
  assert.ok((await s.orgSkills()).some((k: any) => k.name === "col-beta"));
});

test("pack reconciliation and deployment-layer replacement serialize their materialization claims", async (t) => {
  const repo = gitRepo(t, {
    "skills/pack-active/SKILL.md": skillMd("pack-active", "active"),
    "skills/layer-owned/helper.txt": "from pack",
  });
  const s = start(t);
  const id = (await s.register({ url: repo.dir, ref: repo.sha })).id as string;
  const gate = gateBundlePut(s);

  const importing = s.importPack(id);
  await gate.entered;
  const replacing = s.built.deploymentLayerStore.put(
    {
      contract: 1,
      tools: [],
      skills: [
        { path: "skills/layer-owned/SKILL.md", content: md("name: layer-owned\ndescription: deployment") },
        { path: "skills/layer-owned/helper.txt", content: "from deployment" },
      ],
    },
    "test",
  );
  gate.release();

  assert.equal((await importing).status, 200);
  await assert.rejects(replacing, /skills\/layer-owned\/helper\.txt, already claimed by pack:/);
});

test("pack removal waits for an in-flight reconciliation and leaves no orphan records", async (t) => {
  const repo = fixtureRepo(t);
  const s = start(t);
  const id = (await s.register({ url: repo.dir, ref: repo.sha, ...EXCLUDE_TRUSTED })).id as string;
  const gate = gateBundlePut(s);

  const importing = s.importPack(id);
  await gate.entered;
  let removed = false;
  const removing = s.remove(id).then((response) => {
    removed = true;
    return response;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(removed, false);
  gate.release();

  assert.equal((await importing).status, 200);
  assert.equal((await removing).status, 200);
  assert.equal(await s.built.skillBundles.get(id), null);
  assert.ok(!(await s.orgSkills()).some((skill: any) => skill.createdBy === `pack:${id}`));
  assert.ok(!(await s.packs()).some((pack: any) => pack.id === id));
});

test("an older tracked-pack fetch cannot roll back a newer reconciliation", async (t) => {
  const repo = fixtureRepo(t);
  const s = start(t);
  const id = (await s.register({ url: repo.dir, ...EXCLUDE_TRUSTED })).id as string;
  const originalFetch = s.built.skillFetcher.fetch.bind(s.built.skillFetcher);
  const { promise: oldFetchEntered, resolve: entered } = Promise.withResolvers<void>();
  const { promise: oldFetchRelease, resolve: release } = Promise.withResolvers<void>();
  let first = true;
  s.built.skillFetcher.fetch = async (pack) => {
    const fetched = await originalFetch(pack);
    if (first) {
      first = false;
      entered();
      await oldFetchRelease;
    }
    return fetched;
  };

  const older = s.importPack(id);
  await oldFetchEntered;

  repo.write({ "skills/reg-alpha/SKILL.md": skillMd("reg-alpha", "newest") });
  const newestCommit = repo.commit("newer");

  assert.equal((await s.importPack(id)).status, 200);
  release();

  const stale = await older;
  assert.equal(stale.status, 500);
  assert.equal((await json(stale)).message, "internal server error");
  assert.equal((await s.built.skillBundles.get(id))?.commit, newestCommit);
  const stored = (await s.built.skills.list()).find(
    (skill) => skill.createdBy === `pack:${id}` && skill.manifest.name === "reg-alpha",
  );
  assert.equal(stored?.manifest.description, "newest");
});

test("re-import archives removed/renamed/now-ineligible skills and keeps unchanged ones", async (t) => {
  const repo = gitRepo(t, skillFiles("recon-keep", "recon-del", "recon-ren", "recon-flip"));
  const s = start(t);
  const id = (await s.register({ url: repo.dir })).id as string;
  assert.deepEqual((await s.importJson(id)).imported.sort(), ["recon-del", "recon-flip", "recon-keep", "recon-ren"]);

  repo.remove("skills/recon-del", "skills/recon-ren");
  repo.write({
    ...skillFiles("recon-ren2"),
    "skills/recon-flip/SKILL.md": skillMd("recon-flip", "d", "personal"),
  });
  repo.commit("mutate");

  const imp2 = await s.importJson(id);
  assert.deepEqual(imp2.imported, ["recon-ren2"], "the renamed-to (new) skill imports");
  assert.deepEqual(
    imp2.archived.sort(),
    ["recon-del", "recon-flip", "recon-ren"],
    "deleted + renamed-from + now-personal are archived",
  );

  const published = (await s.orgSkills())
    .filter((k: any) => k.status === "published")
    .map((k: any) => k.name)
    .sort();
  assert.ok(published.includes("recon-keep") && published.includes("recon-ren2"), "unchanged + renamed-to survive");
  assert.ok(
    !["recon-del", "recon-ren", "recon-flip"].some((n) => published.includes(n)),
    "removed/renamed-from/now-personal are gone",
  );
});

test("sync refreshes IMPORTED skills (update + archive) but does NOT add un-imported ones; PATCH flips syncMode", async (t) => {
  const repo = gitRepo(t, skillFiles("sync-a", "sync-keep"));
  const s = start(t);
  const id = (await s.register({ url: repo.dir })).id as string;
  await s.importPack(id);

  const patched = await json(
    await fetch(`${s.base}/v1/admin/skill-packs/${id}`, {
      method: "PATCH",
      headers: ADMIN,
      body: JSON.stringify({ syncMode: "tracked" }),
    }),
  );
  assert.equal(patched.pack.syncMode, "tracked");

  repo.write({ ...skillFiles("sync-new"), "skills/sync-a/SKILL.md": skillMd("sync-a", "CHANGED") });
  repo.remove("skills/sync-keep");
  repo.commit("evolve");

  const synced = await json(await s.post(`/${id}/sync`, {}));
  assert.deepEqual(synced.updated, ["sync-a"], "a changed imported skill is updated");
  assert.deepEqual(synced.archived, ["sync-keep"], "an imported skill removed upstream is archived");
  assert.ok(!synced.imported.includes("sync-new"), "sync does NOT add a skill that was never imported");

  const [afterSync] = await s.packs();
  assert.equal(afterSync.lastImport.counts.imported, 0, "sync adds nothing new");
  assert.equal(afterSync.lastImport.counts.updated, 1, "the changed imported skill counts as updated");
  assert.equal(afterSync.lastImport.counts.archived, 1, "the removed imported skill counts as archived");

  const published = (await s.orgSkills()).filter((k: any) => k.status === "published").map((k: any) => k.name);
  assert.ok(published.includes("sync-a"), "the updated skill stays live");
  assert.ok(!published.includes("sync-keep"), "the removed-upstream skill is archived");
  assert.ok(!published.includes("sync-new"), "the new upstream skill is NOT auto-added by sync");
});

test("a single imported skill can be un-indexed (archived) via DELETE /admin/skills/:id", async (t) => {
  const repo = fixtureRepo(t);
  const s = start(t);
  await s.importPack((await s.register({ url: repo.dir, ref: repo.sha, ...EXCLUDE_TRUSTED })).id);
  const alpha = (await s.orgSkills()).find((k: any) => k.name === "reg-alpha");
  assert.equal(alpha.status, "published");

  const del = await fetch(`${s.base}/v1/admin/skills/${alpha.id}?scope=org:default-org`, {
    method: "DELETE",
    headers: ADMIN,
  });
  assert.equal(del.status, 200);

  const skills = await s.orgSkills();
  const after = skills.find((k: any) => k.name === "reg-alpha");
  assert.ok(!after || after.status === "archived", "the un-indexed skill is no longer published");
  assert.equal(skills.find((k: any) => k.name === "reg-beta")?.status, "published", "sibling skill is untouched");
});

test("remove then re-register the same repo re-imports cleanly (no stuck-archived records)", async (t) => {
  const repo = fixtureRepo(t);
  const s = start(t);
  const first = await s.register({ url: repo.dir, ref: repo.sha, ...EXCLUDE_TRUSTED });
  assert.deepEqual((await s.importJson(first.id)).imported.sort(), ["reg-alpha", "reg-beta"]);
  assert.equal((await json(await s.remove(first.id))).removed, 2);

  const second = await s.register({ url: repo.dir, ref: repo.sha, ...EXCLUDE_TRUSTED });
  assert.deepEqual(
    (await s.importJson(second.id)).imported.sort(),
    ["reg-alpha", "reg-beta"],
    "re-add re-imports (delete-on-remove cleared the tombstones)",
  );
  assert.equal(
    (await s.orgSkills()).filter((k: any) => k.name === "reg-alpha" && k.status === "published").length,
    1,
    "exactly one published reg-alpha (no tombstone)",
  );
});

test("skill-pack routes are admin-only and audited", async (t) => {
  const s = start(t);
  assert.equal(
    (await fetch(`${s.base}/v1/admin/skill-packs`, { headers: { "x-admin-actor": "nobody@default-org" } })).status,
    403,
  );
  await s.packs();
  assert.ok((await s.built.auditLog.events()).some((e) => e.action === "skill_packs.read"));
});

test("imports a pack into MULTIPLE scopes at once; catalog reports per-scope; importedCount is distinct", async (t) => {
  const repo = fixtureRepo(t);
  const s = start(t);
  const id = (await s.register({ url: repo.dir, ref: repo.sha, ...EXCLUDE_TRUSTED })).id as string;

  const imp = await s.importJson(id, { selected: "all", scopeIds: BOTH_SCOPES });
  assert.equal(imp.imported.length, 4, "2 eligible skills × 2 scopes = 4 installs");

  assert.deepEqual(await s.packSkillsIn("org:default-org", id), ["reg-alpha", "reg-beta"]);
  assert.deepEqual(await s.packSkillsIn("personal:admin-alice", id), ["reg-alpha", "reg-beta"]);

  const cat = await s.getJson(`/skill-packs/${id}/catalog`);
  assert.deepEqual(cat.candidates.find((c: any) => c.upstreamName === "reg-alpha")?.importedScopes.sort(), BOTH_SCOPES);

  assert.equal((await s.packs())[0].importedCount, 2, "distinct skills imported, not per-scope records");
});

test("re-importing into ONE scope archives only that scope's deselected skills, not another scope's", async (t) => {
  const repo = gitRepo(t, skillFiles("scoped-a", "scoped-b"));
  const s = start(t);
  const id = (await s.register({ url: repo.dir })).id as string;
  await s.importPack(id, { selected: "all", scopeIds: BOTH_SCOPES });

  const imp2 = await s.importJson(id, { selected: ["scoped-a"], scopeIds: ["personal:admin-alice"] });
  assert.deepEqual(imp2.archived, ["scoped-b"], "alice's deselected skill is archived");
  assert.deepEqual(
    await s.packSkillsIn("org:default-org", id),
    ["scoped-a", "scoped-b"],
    "the OTHER scope's skills are untouched",
  );
  assert.deepEqual(
    await s.packSkillsIn("personal:admin-alice", id),
    ["scoped-a"],
    "only the re-imported skill remains in the targeted scope",
  );
});

test("sync refreshes EVERY scope the pack was imported into", async (t) => {
  const repo = gitRepo(t, skillFiles("ms-a", "ms-keep"));
  const s = start(t);
  const id = (await s.register({ url: repo.dir })).id as string;
  await s.importPack(id, { selected: "all", scopeIds: BOTH_SCOPES });

  repo.write({ "skills/ms-a/SKILL.md": skillMd("ms-a", "CHANGED") });
  repo.remove("skills/ms-keep");
  repo.commit("evolve");

  const synced = await json(await s.post(`/${id}/sync`, {}));
  assert.deepEqual(synced.updated.sort(), ["ms-a", "ms-a"], "the changed skill is updated in BOTH imported scopes");
  assert.deepEqual(
    synced.archived.sort(),
    ["ms-keep", "ms-keep"],
    "the removed skill is archived in BOTH imported scopes",
  );
  assert.equal(synced.imported.length, 0, "sync adds nothing new");

  assert.deepEqual(await s.packSkillsIn("org:default-org", id), ["ms-a"]);
  assert.deepEqual(await s.packSkillsIn("personal:admin-alice", id), ["ms-a"]);
});

test("import rejects malformed scopeIds with a 400", async (t) => {
  const repo = fixtureRepo(t);
  const s = start(t);
  const pack = await s.register({ url: repo.dir, ref: repo.sha, ...EXCLUDE_TRUSTED });
  const bad = await s.importPack(pack.id, { selected: "all", scopeIds: ["not-a-scope"] });
  assert.equal(bad.status, 400);
  assert.match((await json(bad)).message, /scopeIds/);
});

test("a pack skill whose name collides with a native skill in ANOTHER scope still imports into its own scope", async (t) => {
  const repo = gitRepo(t, { "skills/shared-name/SKILL.md": skillMd("shared-name", "from pack") });
  const s = start(t);
  const nat = await s.built.skills.create({
    scopeId: "org:default-org",
    manifest: { name: "shared-name", description: "native", requiredCapabilities: [], body: "x" },
    createdBy: "system:native",
  });
  await s.built.skills.review(nat.id, "system:native", []);
  await s.built.skills.publish(nat.id);

  const pack = await s.register({ url: repo.dir });
  const imp = await s.importPack(pack.id, { selected: "all", scopeIds: ["personal:admin-alice"] });
  assert.equal(imp.status, 200, "org's same-named native skill must not clobber-block a sub-scope import");
  assert.deepEqual((await json(imp)).imported, ["shared-name"], "the pack skill imports into its own scope");
  assert.deepEqual(await s.packSkillsIn("personal:admin-alice", pack.id), ["shared-name"]);
  const orgNative = (await s.orgSkills()).find(
    (k: any) => k.name === "shared-name" && k.ownerScopeId === "org:default-org",
  );
  assert.equal(orgNative?.status, "published", "the org native skill is untouched");
});
