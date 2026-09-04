import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "x-admin-actor": "admin-alice@default-org", "content-type": "application/json" };
const json = async (r: Response): Promise<any> => r.json();
const md = (front: string) => `---\n${front}\n---\n# Body\ntext`;

function makeFixtureRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "qm-reg-fixture-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const g = (...a: string[]): void => {
    execFileSync("git", a, { cwd: dir, env, stdio: "ignore" });
  };
  g("init", "-q");
  mkdirSync(join(dir, "skills", "reg-beta", "scripts"), { recursive: true });
  mkdirSync(join(dir, "skills", "reg-alpha"), { recursive: true });
  mkdirSync(join(dir, "skills", "reg-personal"), { recursive: true });
  mkdirSync(join(dir, "trusted", "reg-secret"), { recursive: true });
  writeFileSync(join(dir, "skills", "reg-alpha", "SKILL.md"), md("name: reg-alpha\ndescription: a\nscope: company"));
  writeFileSync(join(dir, "skills", "reg-beta", "SKILL.md"), md("name: reg-beta\ndescription: b\nscope: company"));
  writeFileSync(join(dir, "skills", "reg-beta", "scripts", "x.py"), "print(1)");
  writeFileSync(
    join(dir, "skills", "reg-personal", "SKILL.md"),
    md("name: reg-personal\ndescription: p\nscope: personal"),
  );
  writeFileSync(join(dir, "trusted", "reg-secret", "SKILL.md"), md("name: reg-secret\ndescription: s\nscope: company"));
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "lib", "shared.mjs"), "export const x = 1;");
  mkdirSync(join(dir, "skills", "_conventions"), { recursive: true });
  writeFileSync(join(dir, "skills", "_conventions", "quality.md"), "# quality");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, env }).toString().trim();
  return { dir, sha };
}

function makeRepoWithSharedLib(skillName: string): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "qm-col-fixture-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const g = (...a: string[]): void => {
    execFileSync("git", a, { cwd: dir, env, stdio: "ignore" });
  };
  g("init", "-q");
  mkdirSync(join(dir, "skills", skillName), { recursive: true });
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "skills", skillName, "SKILL.md"), md(`name: ${skillName}\ndescription: d\nscope: company`));
  writeFileSync(join(dir, "lib", "shared.mjs"), `export const who = "${skillName}";`);
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, env }).toString().trim();
  return { dir, sha };
}

function makeRepoWithLayerCollision(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-col-fixture-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const g = (...a: string[]): void => {
    execFileSync("git", a, { cwd: dir, env, stdio: "ignore" });
  };
  g("init", "-q");
  mkdirSync(join(dir, "skills", "pack-active"), { recursive: true });
  mkdirSync(join(dir, "skills", "layer-owned"), { recursive: true });
  writeFileSync(
    join(dir, "skills", "pack-active", "SKILL.md"),
    md("name: pack-active\ndescription: active\nscope: company"),
  );
  writeFileSync(join(dir, "skills", "layer-owned", "helper.txt"), "from pack");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, env }).toString().trim();
  return { dir, sha };
}

function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "reg-routes-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    sessions: built.sessions,
    errors: built.errors,
  });
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    built,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("register → browse → import → list → remove a git skill pack (org scope)", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const reg = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: repo.dir, ref: repo.sha, config: { exclude: ["trusted/*"] } }),
      }),
    );
    const id = reg.pack.id as string;
    assert.ok(id);
    assert.equal(reg.pack.targetScopeId, "org:default-org");
    assert.equal(reg.pack.syncMode, "pinned");
    assert.equal(
      reg.pack.available,
      2,
      "registration scans the repo so the available (eligible) count shows immediately",
    );

    const cat = await json(await fetch(`${s.base}/v1/admin/skill-packs/${id}/catalog`, { headers: ADMIN }));
    assert.equal(cat.counts.eligible, 2);
    assert.equal(cat.counts.scope, 1);
    assert.ok(!cat.candidates.some((c: any) => c.upstreamName === "reg-secret"));
    assert.ok(
      !cat.candidates.some((c: any) => (c.importedScopes || []).length),
      "nothing is imported anywhere before importing",
    );

    const imp = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ selected: "all" }),
      }),
    );
    assert.deepEqual(imp.imported.sort(), ["reg-alpha", "reg-beta"]);

    const cat2 = await json(await fetch(`${s.base}/v1/admin/skill-packs/${id}/catalog`, { headers: ADMIN }));
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

    const skills = await json(await fetch(`${s.base}/v1/admin/skills?scope=org:default-org`, { headers: ADMIN }));
    const alpha = skills.skills.find((k: any) => k.name === "reg-alpha");
    assert.ok(alpha, "imported skill is listed");
    assert.equal(alpha.status, "published");
    assert.equal(alpha.ownerScopeId, "org:default-org");

    const list = await json(await fetch(`${s.base}/v1/admin/skill-packs`, { headers: ADMIN }));
    assert.equal(list.packs.length, 1);
    assert.equal(list.packs[0].lastImport.status, "ok");
    assert.equal(list.packs[0].importedCount, 2, "2 skills currently imported from this pack");
    assert.equal(list.packs[0].lastImport.counts.eligible, 2, "available (eligible) count is on lastImport.counts");

    const del = await json(await fetch(`${s.base}/v1/admin/skill-packs/${id}`, { method: "DELETE", headers: ADMIN }));
    assert.equal(del.removed, 2);
    assert.equal((await json(await fetch(`${s.base}/v1/admin/skill-packs`, { headers: ADMIN }))).packs.length, 0);
    assert.equal(await s.built.skillBundles.get(id), null, "removing the pack deletes its shared bundle too");
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("register works with only a url (defaults to the repo's default branch)", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const reg = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: repo.dir, config: { exclude: ["trusted/*"] } }),
      }),
    );
    assert.ok(reg.pack.id);
    assert.equal(reg.pack.ref, "");
    const imp = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${reg.pack.id}/import`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ selected: "all" }),
      }),
    );
    assert.deepEqual(imp.imported.sort(), ["reg-alpha", "reg-beta"]);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("a legacy published skill with an unsafe name does not block unrelated pack reconciliation", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const legacy = await s.built.skills.create({
      scopeId: "org:default-org",
      manifest: { name: "legacy-safe", description: "legacy", requiredCapabilities: [], body: "legacy" },
      createdBy: "legacy-import",
    });
    await s.built.skills.review(legacy.id, "reviewer", []);
    await s.built.skills.publish(legacy.id);
    legacy.manifest.name = "Legacy Skill";

    const reg = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: repo.dir, ref: repo.sha }),
      }),
    );
    const imported = await fetch(`${s.base}/v1/admin/skill-packs/${reg.pack.id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: ["reg-alpha"] }),
    });
    assert.equal(imported.status, 200);
    assert.deepEqual((await json(imported)).imported, ["reg-alpha"]);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("supporting files are namespaced per pack, so same paths never clobber", async () => {
  const a = makeRepoWithSharedLib("col-alpha");
  const b = makeRepoWithSharedLib("col-beta");
  const s = start();
  try {
    const regA = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: a.dir, ref: a.sha }),
      }),
    );
    const idA = regA.pack.id as string;
    await fetch(`${s.base}/v1/admin/skill-packs/${idA}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all" }),
    });

    const regB = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: b.dir, ref: b.sha }),
      }),
    );
    const idB = regB.pack.id as string;
    const impB = await fetch(`${s.base}/v1/admin/skill-packs/${idB}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all" }),
    });

    assert.equal(impB.status, 200);

    assert.equal(
      (await s.built.skillBundles.get(idA))?.files.find((f) => f.path === "lib/shared.mjs")?.content,
      'export const who = "col-alpha";',
    );
    assert.equal(
      (await s.built.skillBundles.get(idB))?.files.find((f) => f.path === "lib/shared.mjs")?.content,
      'export const who = "col-beta";',
    );
    const skills = await json(await fetch(`${s.base}/v1/admin/skills?scope=org:default-org`, { headers: ADMIN }));
    assert.ok(skills.skills.some((k: any) => k.name === "col-beta"));
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("pack reconciliation and deployment-layer replacement serialize their materialization claims", async () => {
  const repo = makeRepoWithLayerCollision();
  const s = start();
  try {
    const reg = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: repo.dir, ref: repo.sha }),
      }),
    );
    const id = reg.pack.id as string;
    const originalPut = s.built.skillBundles.put.bind(s.built.skillBundles);
    let entered!: () => void;
    let release!: () => void;
    const bundleEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const bundleRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.built.skillBundles.put = async (bundle) => {
      entered();
      await bundleRelease;
      await originalPut(bundle);
    };

    const importing = fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all" }),
    });
    await bundleEntered;
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
    release();

    assert.equal((await importing).status, 200);
    await assert.rejects(replacing, /skills\/layer-owned\/helper\.txt, already claimed by pack:/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("pack removal waits for an in-flight reconciliation and leaves no orphan records", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const reg = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: repo.dir, ref: repo.sha, config: { exclude: ["trusted/*"] } }),
      }),
    );
    const id = reg.pack.id as string;
    const originalPut = s.built.skillBundles.put.bind(s.built.skillBundles);
    let entered!: () => void;
    let release!: () => void;
    const bundleEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const bundleRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.built.skillBundles.put = async (bundle) => {
      entered();
      await bundleRelease;
      await originalPut(bundle);
    };

    const importing = fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all" }),
    });
    await bundleEntered;
    let removed = false;
    const removing = fetch(`${s.base}/v1/admin/skill-packs/${id}`, { method: "DELETE", headers: ADMIN }).then(
      (response) => {
        removed = true;
        return response;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(removed, false);
    release();

    assert.equal((await importing).status, 200);
    assert.equal((await removing).status, 200);
    assert.equal(await s.built.skillBundles.get(id), null);
    const skills = await json(await fetch(`${s.base}/v1/admin/skills?scope=org:default-org`, { headers: ADMIN }));
    assert.ok(!skills.skills.some((skill: any) => skill.createdBy === `pack:${id}`));
    const packs = await json(await fetch(`${s.base}/v1/admin/skill-packs`, { headers: ADMIN }));
    assert.ok(!packs.packs.some((pack: any) => pack.id === id));
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("an older tracked-pack fetch cannot roll back a newer reconciliation", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const reg = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: repo.dir, config: { exclude: ["trusted/*"] } }),
      }),
    );
    const id = reg.pack.id as string;
    const originalFetch = s.built.skillFetcher.fetch.bind(s.built.skillFetcher);
    let entered!: () => void;
    let release!: () => void;
    const oldFetchEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const oldFetchRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
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

    const older = fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all" }),
    });
    await oldFetchEntered;

    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    writeFileSync(
      join(repo.dir, "skills", "reg-alpha", "SKILL.md"),
      md("name: reg-alpha\ndescription: newest\nscope: company"),
    );
    execFileSync("git", ["add", "-A"], { cwd: repo.dir, env, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "newer"], { cwd: repo.dir, env, stdio: "ignore" });
    const newestCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.dir, env, encoding: "utf8" }).trim();

    const newer = await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all" }),
    });
    assert.equal(newer.status, 200);
    release();

    const stale = await older;
    assert.equal(stale.status, 500);
    assert.equal((await json(stale)).message, "internal server error");
    assert.equal((await s.built.skillBundles.get(id))?.commit, newestCommit);
    const stored = (await s.built.skills.list()).find(
      (skill) => skill.createdBy === `pack:${id}` && skill.manifest.name === "reg-alpha",
    );
    assert.equal(stored?.manifest.description, "newest");
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("re-import archives removed/renamed/now-ineligible skills and keeps unchanged ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-recon-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const g = (...a: string[]): void => {
    execFileSync("git", a, { cwd: dir, env, stdio: "ignore" });
  };
  const writeSkill = (name: string, scope = "company"): void => {
    mkdirSync(join(dir, "skills", name), { recursive: true });
    writeFileSync(join(dir, "skills", name, "SKILL.md"), md(`name: ${name}\ndescription: d\nscope: ${scope}`));
  };
  g("init", "-q");
  for (const n of ["recon-keep", "recon-del", "recon-ren", "recon-flip"]) writeSkill(n);
  g("add", "-A");
  g("commit", "-q", "-m", "init");

  const s = start();
  try {
    const reg = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: dir }),
      }),
    );
    const id = reg.pack.id as string;
    const imp1 = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ selected: "all" }),
      }),
    );
    assert.deepEqual(imp1.imported.sort(), ["recon-del", "recon-flip", "recon-keep", "recon-ren"]);

    rmSync(join(dir, "skills", "recon-del"), { recursive: true, force: true });
    rmSync(join(dir, "skills", "recon-ren"), { recursive: true, force: true });
    writeSkill("recon-ren2");
    writeFileSync(
      join(dir, "skills", "recon-flip", "SKILL.md"),
      md("name: recon-flip\ndescription: d\nscope: personal"),
    );
    g("add", "-A");
    g("commit", "-q", "-m", "mutate");

    const imp2 = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ selected: "all" }),
      }),
    );
    assert.deepEqual(imp2.imported, ["recon-ren2"], "the renamed-to (new) skill imports");
    assert.deepEqual(
      imp2.archived.sort(),
      ["recon-del", "recon-flip", "recon-ren"],
      "deleted + renamed-from + now-personal are archived",
    );

    const skills = await json(await fetch(`${s.base}/v1/admin/skills?scope=org:default-org`, { headers: ADMIN }));
    const published = skills.skills
      .filter((k: any) => k.status === "published")
      .map((k: any) => k.name)
      .sort();
    assert.ok(published.includes("recon-keep") && published.includes("recon-ren2"), "unchanged + renamed-to survive");
    assert.ok(
      !["recon-del", "recon-ren", "recon-flip"].some((n) => published.includes(n)),
      "removed/renamed-from/now-personal are gone",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await s.close();
  }
});

test("sync refreshes IMPORTED skills (update + archive) but does NOT add un-imported ones; PATCH flips syncMode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-sync-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const g = (...a: string[]): void => {
    execFileSync("git", a, { cwd: dir, env, stdio: "ignore" });
  };
  const writeSkill = (name: string, desc = "d"): void => {
    mkdirSync(join(dir, "skills", name), { recursive: true });
    writeFileSync(join(dir, "skills", name, "SKILL.md"), md(`name: ${name}\ndescription: ${desc}\nscope: company`));
  };
  g("init", "-q");
  writeSkill("sync-a");
  writeSkill("sync-keep");
  g("add", "-A");
  g("commit", "-q", "-m", "init");

  const s = start();
  try {
    const reg = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: dir }),
      }),
    );
    const id = reg.pack.id as string;
    await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all" }),
    });

    const patched = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}`, {
        method: "PATCH",
        headers: ADMIN,
        body: JSON.stringify({ syncMode: "tracked" }),
      }),
    );
    assert.equal(patched.pack.syncMode, "tracked");

    writeSkill("sync-new");
    writeSkill("sync-a", "CHANGED");
    rmSync(join(dir, "skills", "sync-keep"), { recursive: true, force: true });
    g("add", "-A");
    g("commit", "-q", "-m", "evolve");

    const synced = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}/sync`, { method: "POST", headers: ADMIN, body: "{}" }),
    );
    assert.deepEqual(synced.updated, ["sync-a"], "a changed imported skill is updated");
    assert.deepEqual(synced.archived, ["sync-keep"], "an imported skill removed upstream is archived");
    assert.ok(!synced.imported.includes("sync-new"), "sync does NOT add a skill that was never imported");

    const afterSync = await json(await fetch(`${s.base}/v1/admin/skill-packs`, { headers: ADMIN }));
    assert.equal(afterSync.packs[0].lastImport.counts.imported, 0, "sync adds nothing new");
    assert.equal(afterSync.packs[0].lastImport.counts.updated, 1, "the changed imported skill counts as updated");
    assert.equal(afterSync.packs[0].lastImport.counts.archived, 1, "the removed imported skill counts as archived");

    const published = (
      await json(await fetch(`${s.base}/v1/admin/skills?scope=org:default-org`, { headers: ADMIN }))
    ).skills
      .filter((k: any) => k.status === "published")
      .map((k: any) => k.name);
    assert.ok(published.includes("sync-a"), "the updated skill stays live");
    assert.ok(!published.includes("sync-keep"), "the removed-upstream skill is archived");
    assert.ok(!published.includes("sync-new"), "the new upstream skill is NOT auto-added by sync");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await s.close();
  }
});

test("a single imported skill can be un-indexed (archived) via DELETE /admin/skills/:id", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const reg = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: repo.dir, ref: repo.sha, config: { exclude: ["trusted/*"] } }),
      }),
    );
    await fetch(`${s.base}/v1/admin/skill-packs/${reg.pack.id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all" }),
    });
    let skills = await json(await fetch(`${s.base}/v1/admin/skills?scope=org:default-org`, { headers: ADMIN }));
    const alpha = skills.skills.find((k: any) => k.name === "reg-alpha");
    assert.equal(alpha.status, "published");

    const del = await fetch(`${s.base}/v1/admin/skills/${alpha.id}?scope=org:default-org`, {
      method: "DELETE",
      headers: ADMIN,
    });
    assert.equal(del.status, 200);

    skills = await json(await fetch(`${s.base}/v1/admin/skills?scope=org:default-org`, { headers: ADMIN }));
    const after = skills.skills.find((k: any) => k.name === "reg-alpha");
    assert.ok(!after || after.status === "archived", "the un-indexed skill is no longer published");
    assert.equal(
      skills.skills.find((k: any) => k.name === "reg-beta")?.status,
      "published",
      "sibling skill is untouched",
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("remove then re-register the same repo re-imports cleanly (no stuck-archived records)", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const reg1 = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: repo.dir, ref: repo.sha, config: { exclude: ["trusted/*"] } }),
      }),
    );
    const imp1 = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${reg1.pack.id}/import`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ selected: "all" }),
      }),
    );
    assert.deepEqual(imp1.imported.sort(), ["reg-alpha", "reg-beta"]);
    const del = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${reg1.pack.id}`, { method: "DELETE", headers: ADMIN }),
    );
    assert.equal(del.removed, 2);

    const reg2 = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: repo.dir, ref: repo.sha, config: { exclude: ["trusted/*"] } }),
      }),
    );
    const imp2 = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${reg2.pack.id}/import`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ selected: "all" }),
      }),
    );
    assert.deepEqual(
      imp2.imported.sort(),
      ["reg-alpha", "reg-beta"],
      "re-add re-imports (delete-on-remove cleared the tombstones)",
    );
    const skills = await json(await fetch(`${s.base}/v1/admin/skills?scope=org:default-org`, { headers: ADMIN }));
    assert.equal(
      skills.skills.filter((k: any) => k.name === "reg-alpha" && k.status === "published").length,
      1,
      "exactly one published reg-alpha (no tombstone)",
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("skill-pack routes are admin-only and audited", async () => {
  const s = start();
  try {
    assert.equal(
      (await fetch(`${s.base}/v1/admin/skill-packs`, { headers: { "x-admin-actor": "nobody@default-org" } })).status,
      403,
    );
    await fetch(`${s.base}/v1/admin/skill-packs`, { headers: ADMIN });
    assert.ok((await s.built.auditLog.events()).some((e) => e.action === "skill_packs.read"));
  } finally {
    await s.close();
  }
});

const packSkillsIn = async (base: string, scope: string, packId: string): Promise<string[]> =>
  (await json(await fetch(`${base}/v1/admin/skills?scope=${encodeURIComponent(scope)}`, { headers: ADMIN }))).skills
    .filter((k: any) => k.status === "published" && k.ownerScopeId === scope && k.pack?.id === packId)
    .map((k: any) => k.name)
    .sort();

test("imports a pack into MULTIPLE scopes at once; catalog reports per-scope; importedCount is distinct", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const reg = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: repo.dir, ref: repo.sha, config: { exclude: ["trusted/*"] } }),
      }),
    );
    const id = reg.pack.id as string;

    const imp = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ selected: "all", scopeIds: ["org:default-org", "personal:admin-alice"] }),
      }),
    );
    assert.equal(imp.imported.length, 4, "2 eligible skills × 2 scopes = 4 installs");

    assert.deepEqual(await packSkillsIn(s.base, "org:default-org", id), ["reg-alpha", "reg-beta"]);
    assert.deepEqual(await packSkillsIn(s.base, "personal:admin-alice", id), ["reg-alpha", "reg-beta"]);

    const cat = await json(await fetch(`${s.base}/v1/admin/skill-packs/${id}/catalog`, { headers: ADMIN }));
    assert.deepEqual(cat.candidates.find((c: any) => c.upstreamName === "reg-alpha")?.importedScopes.sort(), [
      "org:default-org",
      "personal:admin-alice",
    ]);

    const list = await json(await fetch(`${s.base}/v1/admin/skill-packs`, { headers: ADMIN }));
    assert.equal(list.packs[0].importedCount, 2, "distinct skills imported, not per-scope records");
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("re-importing into ONE scope archives only that scope's deselected skills, not another scope's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-scoped-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const g = (...a: string[]): void => {
    execFileSync("git", a, { cwd: dir, env, stdio: "ignore" });
  };
  const writeSkill = (name: string): void => {
    mkdirSync(join(dir, "skills", name), { recursive: true });
    writeFileSync(join(dir, "skills", name, "SKILL.md"), md(`name: ${name}\ndescription: d\nscope: company`));
  };
  g("init", "-q");
  writeSkill("scoped-a");
  writeSkill("scoped-b");
  g("add", "-A");
  g("commit", "-q", "-m", "init");

  const s = start();
  try {
    const reg = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: dir }),
      }),
    );
    const id = reg.pack.id as string;

    await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all", scopeIds: ["org:default-org", "personal:admin-alice"] }),
    });

    const imp2 = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ selected: ["scoped-a"], scopeIds: ["personal:admin-alice"] }),
      }),
    );
    assert.deepEqual(imp2.archived, ["scoped-b"], "alice's deselected skill is archived");

    assert.deepEqual(
      await packSkillsIn(s.base, "org:default-org", id),
      ["scoped-a", "scoped-b"],
      "the OTHER scope's skills are untouched",
    );
    assert.deepEqual(
      await packSkillsIn(s.base, "personal:admin-alice", id),
      ["scoped-a"],
      "only the re-imported skill remains in the targeted scope",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await s.close();
  }
});

test("sync refreshes EVERY scope the pack was imported into", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-syncmulti-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const g = (...a: string[]): void => {
    execFileSync("git", a, { cwd: dir, env, stdio: "ignore" });
  };
  const writeSkill = (name: string, desc = "d"): void => {
    mkdirSync(join(dir, "skills", name), { recursive: true });
    writeFileSync(join(dir, "skills", name, "SKILL.md"), md(`name: ${name}\ndescription: ${desc}\nscope: company`));
  };
  g("init", "-q");
  writeSkill("ms-a");
  writeSkill("ms-keep");
  g("add", "-A");
  g("commit", "-q", "-m", "init");

  const s = start();
  try {
    const reg = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: dir }),
      }),
    );
    const id = reg.pack.id as string;
    await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all", scopeIds: ["org:default-org", "personal:admin-alice"] }),
    });

    writeSkill("ms-a", "CHANGED");
    rmSync(join(dir, "skills", "ms-keep"), { recursive: true, force: true });
    g("add", "-A");
    g("commit", "-q", "-m", "evolve");

    const synced = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}/sync`, { method: "POST", headers: ADMIN, body: "{}" }),
    );
    assert.deepEqual(synced.updated.sort(), ["ms-a", "ms-a"], "the changed skill is updated in BOTH imported scopes");
    assert.deepEqual(
      synced.archived.sort(),
      ["ms-keep", "ms-keep"],
      "the removed skill is archived in BOTH imported scopes",
    );
    assert.equal(synced.imported.length, 0, "sync adds nothing new");

    assert.deepEqual(await packSkillsIn(s.base, "org:default-org", id), ["ms-a"]);
    assert.deepEqual(await packSkillsIn(s.base, "personal:admin-alice", id), ["ms-a"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await s.close();
  }
});

test("import rejects malformed scopeIds with a 400", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const reg = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: repo.dir, ref: repo.sha, config: { exclude: ["trusted/*"] } }),
      }),
    );
    const bad = await fetch(`${s.base}/v1/admin/skill-packs/${reg.pack.id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all", scopeIds: ["not-a-scope"] }),
    });
    assert.equal(bad.status, 400);
    assert.match((await json(bad)).message, /scopeIds/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("a pack skill whose name collides with a native skill in ANOTHER scope still imports into its own scope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-xscope-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const g = (...a: string[]): void => {
    execFileSync("git", a, { cwd: dir, env, stdio: "ignore" });
  };
  mkdirSync(join(dir, "skills", "shared-name"), { recursive: true });
  writeFileSync(
    join(dir, "skills", "shared-name", "SKILL.md"),
    md("name: shared-name\ndescription: from pack\nscope: company"),
  );
  g("init", "-q");
  g("add", "-A");
  g("commit", "-q", "-m", "init");

  const s = start();
  try {
    const nat = await s.built.skills.create({
      scopeId: "org:default-org",
      manifest: { name: "shared-name", description: "native", requiredCapabilities: [], body: "x" },
      createdBy: "system:native",
    });
    await s.built.skills.review(nat.id, "system:native", []);
    await s.built.skills.publish(nat.id);

    const reg = await json(
      await fetch(`${s.base}/v1/admin/skill-packs`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ url: dir }),
      }),
    );
    const imp = await fetch(`${s.base}/v1/admin/skill-packs/${reg.pack.id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all", scopeIds: ["personal:admin-alice"] }),
    });
    assert.equal(imp.status, 200, "org's same-named native skill must not clobber-block a sub-scope import");
    assert.deepEqual((await json(imp)).imported, ["shared-name"], "the pack skill imports into its own scope");
    assert.deepEqual(await packSkillsIn(s.base, "personal:admin-alice", reg.pack.id), ["shared-name"]);
    const orgNative = (
      await json(await fetch(`${s.base}/v1/admin/skills?scope=org:default-org`, { headers: ADMIN }))
    ).skills.find((k: any) => k.name === "shared-name" && k.ownerScopeId === "org:default-org");
    assert.equal(orgNative?.status, "published", "the org native skill is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await s.close();
  }
});
