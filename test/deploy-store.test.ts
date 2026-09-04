import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployStore, deployCurrentGitRef, publicUrlOf, type Deployment } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import type { DeployGitArchive } from "../src/deploy/deploy-git-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";

test("deploy versions are immutable and rollback flips the pointer", async () => {
  const s = createDeployStore();
  const d = await s.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "v1",
    snapshotDir: "/snap/v1",
  });
  assert.equal(d.currentVersion, 1);
  assert.equal(d.versions.length, 1);

  await s.addVersion(d.id, { entrypoint: "v2", snapshotDir: "/snap/v2" });
  const after = (await s.get(d.id))!;
  assert.equal(after.versions.length, 2, "v1 is retained — versions are append-only");
  assert.equal(after.currentVersion, 2);
  assert.equal((await s.versionOf(d.id, 1))!.snapshotDir, "/snap/v1");

  await s.setCurrentVersion(d.id, 1);
  assert.equal((await s.get(d.id))!.currentVersion, 1);
  assert.equal((await s.get(d.id))!.versions.length, 2, "rollback doesn't drop versions");

  await assert.rejects(s.setCurrentVersion(d.id, 99), /no such version/);
});

test("addVersion on an unknown deployment throws", async () => {
  const s = createDeployStore();
  await assert.rejects(s.addVersion("nope", { entrypoint: "x", snapshotDir: "/x" }), /unknown deployment/);
});

test("addVersionFromCommit registers a pushed commit as a new version inheriting entrypoint/env", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "from-commit-"));
  const s = createDeployStore({ git: { repoRoot } });
  const d = await s.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/v1",
    env: { FOO: "bar" },
    files: [{ path: "server.js", data: "1" }],
  });
  await s.setAppliedVersion(d.id, 1);
  const v1commit = (await s.versionOf(d.id, 1))!.commit!;

  const work = mkdtempSync(join(tmpdir(), "from-commit-work-"));
  const repo = await s.repoUrl(d.id);
  execFileSync("git", ["clone", "--quiet", repo, work]);
  writeFileSync(join(work, "server.js"), "2");
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-aqm", "v2"], { cwd: work });
  execFileSync("git", ["push", "--quiet", repo, "HEAD:current"], { cwd: work });
  const pushed = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work }).toString().trim();
  assert.notEqual(pushed, v1commit);

  const v2 = (await s.addVersionFromCommit(d.id, pushed))!;
  assert.equal(v2.version, 2);
  assert.equal(v2.commit, pushed);
  assert.equal(v2.entrypoint, "node server.js");
  assert.deepEqual(v2.env, { FOO: "bar" });
  assert.equal((await s.get(d.id))!.currentVersion, 2);

  const v2bundle = await s.bundleOf(d.id, 2);
  assert.ok((v2bundle?.byteLength ?? 0) > 0, "a push-deployed version can be exported as a git bundle");

  assert.equal(await s.addVersionFromCommit(d.id, pushed), null);
  assert.equal((await s.get(d.id))!.versions.length, 2);
});

test("a provider without reconcile receives durable Git contents after a push", async () => {
  const root = mkdtempSync(join(tmpdir(), "from-commit-apply-"));
  const deployStore = createDeployStore({ git: { repoRoot: join(root, "repos") } });
  const applied: string[] = [];
  const deploy = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async (_deployment, version) => {
        applied.push(readFileSync(join(version.snapshotDir, "server.js"), "utf8"));
        return { host: "127.0.0.1", port: 8080 };
      },
      destroy: async () => {},
    },
    deployDir: join(root, "snapshots"),
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
  });
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    files: [{ path: "server.js", data: "v1" }],
  });
  const work = mkdtempSync(join(tmpdir(), "from-commit-apply-work-"));
  const repo = await deploy.gitRepoPath(d.id);
  execFileSync("git", ["clone", "--quiet", repo!, work]);
  writeFileSync(join(work, "server.js"), "v2");
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-aqm", "v2"], { cwd: work });
  execFileSync("git", ["push", "--quiet", repo!, "HEAD:current"], { cwd: work });
  await deploy.pushGit(d.id, async () => ({ result: true, ok: true }));
  assert.deepEqual(applied, ["v1", "v2"]);
});

test("homeDir (resident-auth snapshot) round-trips through create + addVersion", async () => {
  const s = createDeployStore();
  const d = await s.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "v1",
    snapshotDir: "/snap/v1",
    homeDir: "/home/v1",
  });
  assert.equal((await s.versionOf(d.id, 1))!.homeDir, "/home/v1");
  await s.addVersion(d.id, { entrypoint: "v2", snapshotDir: "/snap/v2", homeDir: "/home/v2" });
  assert.equal((await s.versionOf(d.id, 2))!.homeDir, "/home/v2");
  await s.addVersion(d.id, { entrypoint: "v3", snapshotDir: "/snap/v3" });
  assert.equal("homeDir" in (await s.versionOf(d.id, 3))!, false);
});

test("setVersionImage records the built image ref onto a version (the durable artifact)", async () => {
  const s = createDeployStore();
  const d = await s.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "v1",
    snapshotDir: "/snap/v1",
  });
  assert.equal("image" in (await s.versionOf(d.id, 1))!, false, "no image until one is recorded");
  await s.setVersionImage(d.id, 1, "registry.fly.io/app:v1");
  assert.equal((await s.versionOf(d.id, 1))!.image, "registry.fly.io/app:v1");

  await s.addVersion(d.id, { entrypoint: "v2", snapshotDir: "/snap/v2" });
  await s.setVersionImage(d.id, 2, "registry.fly.io/app:v2");
  assert.equal((await s.versionOf(d.id, 1))!.image, "registry.fly.io/app:v1", "v1 image unchanged");
  assert.equal((await s.versionOf(d.id, 2))!.image, "registry.fly.io/app:v2");

  await assert.rejects(s.setVersionImage(d.id, 99, "registry.fly.io/app:v99"), /no such version/);
});

test("setDisplayName sets the free-form label and clearing leaves no undefined noise", async () => {
  const s = createDeployStore();
  const d = await s.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    snapshotDir: "/snap",
    name: "slug",
  });
  assert.equal((await s.get(d.id))!.displayName, undefined, "no display label until one is set");
  await s.setDisplayName(d.id, "My Cool App");
  assert.equal((await s.get(d.id))!.displayName, "My Cool App");
  assert.equal((await s.get(d.id))!.name, "slug", "the URL slug is independent of the display label");
  await s.setDisplayName(d.id, undefined);
  assert.equal("displayName" in (await s.get(d.id))!, false, "clearing removes the key (falls back to name/id)");
});

test("touch records last-access for scale-to-zero (C3)", async () => {
  const s = createDeployStore();
  const d = await s.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node s.js",
    snapshotDir: "/snap",
  });
  assert.equal((await s.get(d.id))!.lastAccessAt, undefined);
  await s.touch(d.id, 12345);
  assert.equal((await s.get(d.id))!.lastAccessAt, 12345);
});

test("deploy versions carry git commits for app files and rollback moves the current ref", async () => {
  const deployments = createMemoryMap<Deployment>();
  const repoRoot = mkdtempSync(join(tmpdir(), "deploy-git-"));
  const s1 = createDeployStore({ deployments, git: { repoRoot } });
  const d = await s1.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/v1",
    files: [
      { path: "server.js", data: "console.log('v1')" },
      { path: "data.json", data: '{"n":1}' },
    ],
    homeDir: "/home/v1",
  });
  const v1 = (await s1.versionOf(d.id, 1))!;

  await s1.addVersion(d.id, {
    entrypoint: "node server.js",
    snapshotDir: "/snap/v2",
    files: [
      { path: "server.js", data: "console.log('v1')" },
      { path: "data.json", data: '{"n":2}' },
      { path: "public/index.html", data: "<h1>ok</h1>" },
    ],
    homeDir: "/home/v2",
  });

  const s2 = createDeployStore({ deployments, git: { repoRoot } });
  const v2 = (await s2.versionOf(d.id, 2))!;
  assert.match(v1.commit ?? "", /^[0-9a-f]{40}$/);
  assert.match(v2.commit ?? "", /^[0-9a-f]{40}$/);
  assert.equal(v2.parentCommit, v1.commit, "commits chain from the prior current version");
  assert.equal(
    await s2.refOf(d.id, deployCurrentGitRef),
    null,
    "the hosted current ref is not moved before a version is applied",
  );
  await s2.setAppliedVersion(d.id, 2);
  assert.equal(await s2.refOf(d.id, deployCurrentGitRef), v2.commit);
  assert.ok(existsSync(await s2.repoUrl(d.id)), "a real bare git repo backs the deployment");

  const tree = await s2.treeOf(d.id, 2);
  assert.deepEqual(
    tree?.map((f) => f.path),
    ["data.json", "public/index.html", "server.js"],
  );
  assert.ok(
    !tree?.some((f) => f.path.includes(".aws") || f.path.startsWith("../")),
    "resident home files are not part of app git history",
  );

  const diff = await s2.diffVersions(d.id, 1, 2);
  assert.deepEqual(
    diff?.added.map((f) => f.path),
    ["public/index.html"],
  );
  assert.deepEqual(
    diff?.modified.map((f) => f.path),
    ["data.json"],
  );
  assert.deepEqual(
    diff?.deleted.map((f) => f.path),
    [],
  );

  const bundle = await s2.bundleOf(d.id, 2);
  assert.ok((bundle?.byteLength ?? 0) > 0, "a deploy version can be exported as a git bundle");
  const checkout = mkdtempSync(join(tmpdir(), "deploy-git-bundle-checkout-"));
  const bundlePath = join(checkout, "repo.bundle");
  writeFileSync(bundlePath, bundle!);
  execFileSync("git", ["init", "--quiet"], { cwd: checkout });
  execFileSync("git", ["fetch", "--force", bundlePath, `refs/deploy-commits/${v2.commit}`], { cwd: checkout });
  execFileSync("git", ["checkout", "--quiet", "--force", "FETCH_HEAD"], { cwd: checkout });
  assert.equal(readFileSync(join(checkout, "data.json"), "utf8"), '{"n":2}');

  await s2.setCurrentVersion(d.id, 1);
  assert.equal(
    await s2.refOf(d.id, deployCurrentGitRef),
    v2.commit,
    "selecting a rollback target does not move the hosted current ref before apply",
  );
  await s2.setAppliedVersion(d.id, 1);
  assert.equal(
    await s2.refOf(d.id, deployCurrentGitRef),
    v1.commit,
    "the hosted current ref moves when the rollback version is applied",
  );
});

test("an upload cannot smuggle files into the deployment repo's own git directory", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "deploy-git-dotgit-"));
  const s = createDeployStore({ git: { repoRoot } });
  await assert.rejects(
    s.create({
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      entrypoint: "node app.js",
      snapshotDir: "/snap/v1",
      files: [
        { path: "app.js", data: "console.log('hi')" },
        { path: ".git/config", data: '[core]\n\tfsmonitor = "touch /tmp/qm-should-not-run"\n' },
      ],
    }),
    /invalid deploy path/,
    "a .git path is refused rather than written into the live worktree's git directory",
  );

  for (const bad of [
    ".GIT/config",
    "git~1/config",
    "git~2/config",
    "sub/.git/hooks/pre-commit",
    ".git./config",
    ".git /x",
  ]) {
    await assert.rejects(
      s.create({
        ownerScopeId: scopeId("personal", "U1"),
        createdBy: "U1",
        entrypoint: "node app.js",
        snapshotDir: "/snap/v1",
        files: [{ path: bad, data: "x" }],
      }),
      /invalid deploy path/,
      `${bad} is refused`,
    );
  }

  const ok = await s.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node app.js",
    snapshotDir: "/snap/v1",
    files: [
      { path: "app.js", data: "x" },
      { path: "wrap.git/config", data: "x" },
      { path: "digit~1/x", data: "x" },
      { path: ".git-credentials", data: "x" },
    ],
  });
  assert.deepEqual(
    (await s.treeOf(ok.id, 1))?.map((f) => f.path).sort(),
    [".git-credentials", "app.js", "digit~1/x", "wrap.git/config"],
    "names that merely resemble git metadata are still deployable",
  );
});

test("uploaded files a .gitignore would exclude still reach the deployment's git history", async () => {
  const deployments = createMemoryMap<Deployment>();
  const repoRoot = mkdtempSync(join(tmpdir(), "deploy-git-ignored-"));
  const s = createDeployStore({ deployments, git: { repoRoot } });
  const d = await s.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.cjs",
    snapshotDir: "/snap/v1",
    files: [
      { path: ".gitignore", data: "node_modules\ndist\n" },
      { path: "server.cjs", data: "require('http')" },
      { path: "dist/index.html", data: "<h1>built</h1>" },
      { path: "dist/assets/app.js", data: "console.log('built')" },
    ],
  });

  const tree = await s.treeOf(d.id, 1);
  assert.deepEqual(
    tree?.map((f) => f.path).sort(),
    [".gitignore", "dist/assets/app.js", "dist/index.html", "server.cjs"],
    "the build output the app serves is archived even though the app's .gitignore excludes it",
  );

  const files = await s.filesOf(d.id, 1, ["dist/index.html"]);
  assert.equal(files?.[0]?.data.toString(), "<h1>built</h1>");

  await s.addVersion(d.id, {
    entrypoint: "node server.cjs",
    snapshotDir: "/snap/v2",
    files: [
      { path: ".gitignore", data: "node_modules\ndist\n" },
      { path: "server.cjs", data: "require('http')" },
      { path: "dist/index.html", data: "<h1>rebuilt</h1>" },
    ],
  });
  const v2Tree = await s.treeOf(d.id, 2);
  assert.deepEqual(
    v2Tree?.map((f) => f.path).sort(),
    [".gitignore", "dist/index.html", "server.cjs"],
    "an ignored file dropped from a later upload is removed from history like any other",
  );
});

test("deploy git repos restore from the durable archive into a fresh repo root", async () => {
  const deployments = createMemoryMap<Deployment>();
  const archiveStore = createMemoryMap<DeployGitArchive>();
  const s1 = createDeployStore({
    deployments,
    git: { repoRoot: mkdtempSync(join(tmpdir(), "deploy-git-a-")), archiveStore },
  });
  const d = await s1.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/v1",
    files: [{ path: "server.js", data: "console.log('v1')" }],
  });
  const v1 = (await s1.versionOf(d.id, 1))!;
  await s1.addVersion(d.id, {
    entrypoint: "node server.js",
    snapshotDir: "/snap/v2",
    files: [{ path: "server.js", data: "console.log('v2')" }],
  });

  const s2 = createDeployStore({
    deployments,
    git: { repoRoot: mkdtempSync(join(tmpdir(), "deploy-git-b-")), archiveStore },
  });
  const v2 = (await s2.versionOf(d.id, 2))!;
  await s2.setAppliedVersion(d.id, 2);
  assert.equal(
    await s2.refOf(d.id, deployCurrentGitRef),
    v2.commit,
    "a fresh instance restores refs from the durable bundle",
  );
  assert.ok(existsSync(await s2.repoUrl(d.id)), "the restored bare repo exists on the fresh instance");
  assert.deepEqual(
    (await s2.filesOf(d.id, 2))?.map((f) => [f.path, Buffer.from(f.data).toString("utf8")]),
    [["server.js", "console.log('v2')"]],
  );

  await s2.setCurrentVersion(d.id, 1);
  await s2.setAppliedVersion(d.id, 1);
  const s3 = createDeployStore({
    deployments,
    git: { repoRoot: mkdtempSync(join(tmpdir(), "deploy-git-c-")), archiveStore },
  });
  assert.equal(await s3.refOf(d.id, deployCurrentGitRef), v1.commit, "ref-only changes are also durably archived");
});

test("deploy git archives keep bundle bytes in the byte store, not the row", async () => {
  const deployments = createMemoryMap<Deployment>();
  const archiveStore = createMemoryMap<DeployGitArchive>();
  const archiveBytes = createMemoryDurableByteStore();
  const s1 = createDeployStore({
    deployments,
    git: { repoRoot: mkdtempSync(join(tmpdir(), "deploy-git-blob-a-")), archiveStore, archiveBytes },
  });
  const d = await s1.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/v1",
    files: [{ path: "server.js", data: "console.log('v1')" }],
  });

  const row = (await archiveStore.get(d.id))!;
  assert.equal(row.bundleB64, undefined, "the row carries no bundle bytes");
  assert.ok(row.blobKey, "the row references the bundle blob");
  const firstBlobKey = row.blobKey!;

  const s2 = createDeployStore({
    deployments,
    git: { repoRoot: mkdtempSync(join(tmpdir(), "deploy-git-blob-b-")), archiveStore, archiveBytes },
  });
  assert.deepEqual(
    (await s2.filesOf(d.id, 1))?.map((f) => [f.path, Buffer.from(f.data).toString("utf8")]),
    [["server.js", "console.log('v1')"]],
  );

  await s2.addVersion(d.id, {
    entrypoint: "node server.js",
    snapshotDir: "/snap/v2",
    files: [{ path: "server.js", data: "console.log('v2')" }],
  });
  const row2 = (await archiveStore.get(d.id))!;
  assert.notEqual(row2.blobKey, firstBlobKey, "a new commit stores a new blob");
  assert.ok(
    await archiveBytes.open(firstBlobKey),
    "superseded blobs are kept — content-addressed keys can be shared across deployments",
  );
});

test("legacy inline-bundle rows still restore and migrate to blob refs on read", async () => {
  const deployments = createMemoryMap<Deployment>();
  const archiveStore = createMemoryMap<DeployGitArchive>();
  const s1 = createDeployStore({
    deployments,
    git: { repoRoot: mkdtempSync(join(tmpdir(), "deploy-git-legacy-a-")), archiveStore },
  });
  const d = await s1.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/v1",
    files: [{ path: "server.js", data: "console.log('v1')" }],
  });
  const legacy = (await archiveStore.get(d.id))!;
  assert.ok(legacy.bundleB64, "without a byte store the bundle is stored inline (legacy format)");

  const archiveBytes = createMemoryDurableByteStore();
  const s2 = createDeployStore({
    deployments,
    git: { repoRoot: mkdtempSync(join(tmpdir(), "deploy-git-legacy-b-")), archiveStore, archiveBytes },
  });
  assert.deepEqual(
    (await s2.filesOf(d.id, 1))?.map((f) => [f.path, Buffer.from(f.data).toString("utf8")]),
    [["server.js", "console.log('v1')"]],
  );
  const migrated = (await archiveStore.get(d.id))!;
  assert.equal(migrated.bundleB64, undefined, "reading a legacy row rewrites it without inline bytes");
  assert.ok(migrated.blobKey, "the migrated row references the offloaded blob");
  assert.equal(migrated.etag, legacy.etag, "migration preserves the archive etag");
  assert.ok(await archiveBytes.open(migrated.blobKey!), "the offloaded blob is readable");
});

test("publicUrlOf strips a stale access token from any query position, and leaves clean URLs alone", () => {
  assert.equal(publicUrlOf({ host: "h", port: 1, publicUrl: "https://x.apps.q/?access=tok" }), "https://x.apps.q/");
  assert.equal(
    publicUrlOf({ host: "h", port: 1, publicUrl: "https://x.apps.q/?access=t&y=1" }),
    "https://x.apps.q/?y=1",
    "a following param survives — the old regex glued it to the path",
  );
  assert.equal(
    publicUrlOf({ host: "h", port: 1, publicUrl: "https://x.apps.q/?a=1&access=t" }),
    "https://x.apps.q/?a=1",
    "a non-leading access param is still stripped — the old regex missed it",
  );
  assert.equal(
    publicUrlOf({ host: "h", port: 1, publicUrl: "https://x.apps.q/path?b=2" }),
    "https://x.apps.q/path?b=2",
  );
  assert.equal(publicUrlOf(null), undefined);
  assert.equal(publicUrlOf({ host: "h", port: 1 }), undefined);
});

test("resident home files are held to the same path rules as app files", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "deploy-git-homefiles-"));
  const deployDir = mkdtempSync(join(tmpdir(), "deploy-home-snap-"));
  const s = createDeployStore({ git: { repoRoot } });
  const acl = createAclStore();
  const deploy = createDeployService({
    deployStore: s,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 20000 }),
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl,
    deployDir,
  });
  await assert.rejects(
    deploy.deployOrUpdate({
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      entrypoint: "node app.js",
      files: [{ path: "app.js", data: "x" }],
      homeFiles: [{ path: ".git/config", data: '[core]\n\tfsmonitor = "touch /tmp/qm-should-not-run"\n' }],
    }),
    /invalid deploy path/,
    "a home file cannot smuggle git metadata past the app-file check",
  );
});
