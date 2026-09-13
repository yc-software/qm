import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import type { DeployProvider } from "../src/deploy/deploy-provider.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { scopeId } from "../src/types.ts";

test("mixed deployment providers preserve Git updates, restore, reach, profiles and idle policies", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "provider-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createDeployStore({ git: { repoRoot: join(root, "repos") } });
  const old = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/missing-legacy-snapshot",
    files: [{ path: "server.js", data: "old" }],
  });
  await store.setStatus(old.id, "archived");
  const legacyIds = new Set([old.id]);
  const applied: string[] = [];
  const destroyed: string[] = [];
  let reconciles = 0;
  let resolutions = 0;
  const modern: DeployProvider = {
    profile: { managedScaleToZero: false },
    apply: async (_d, v) => {
      applied.push(readFileSync(join(v.snapshotDir, "server.js"), "utf8"));
      return { host: "modern.flycast", port: 8080 };
    },
    destroy: async (d) => {
      destroyed.push(`modern:${d.id}`);
    },
    logs: async () => "modern logs",
  };
  const legacy: DeployProvider = {
    profile: { managedScaleToZero: true, inPlaceReconcile: true, dataDir: "/data" },
    apply: async () => {
      throw new Error("legacy Git version must reconcile");
    },
    reconcile: async (_d, _v, input) => {
      assert.ok(input.gitBundle?.length);
      reconciles++;
      return { host: "legacy.flycast", port: 80 };
    },
    resolveEndpoint: async () => {
      resolutions++;
      return { host: "legacy.flycast", port: 80 };
    },
    destroy: async (d) => {
      destroyed.push(`legacy:${d.id}`);
    },
  };
  const service = createDeployService({
    deployStore: store,
    provider: modern,
    providerFor: (d) => (legacyIds.has(d.id) ? legacy : modern),
    deployDir: join(root, "snapshots"),
    acl: createAclStore(),
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
  });
  await service.restoreDeployment(old.id);
  assert.equal(reconciles, 1);
  const fresh = await service.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    files: [{ path: "server.js", data: "v1" }],
  });
  assert.equal(service.providerProfileFor!(old).dataDir, "/data");
  assert.equal(service.providerProfileFor!(fresh).dataDir, undefined);
  assert.equal((await service.reachDeployment(fresh.id, "U1", { bypassAcl: true })).status, "ok");
  assert.deepEqual(applied, ["v1"]);
  assert.equal(resolutions, 0);
  assert.equal((await service.reachDeployment(old.id, "U1", { bypassAcl: true })).status, "ok");
  assert.equal(resolutions, 1);
  assert.equal(await service.deploymentLogs(old.id, { tailLines: 10 }), null);
  assert.equal(await service.deploymentLogs(fresh.id, { tailLines: 10 }), "modern logs");
  const work = join(root, "work");
  const repo = (await service.gitRepoPath(fresh.id))!;
  execFileSync("git", ["clone", "--quiet", repo, work]);
  writeFileSync(join(work, "server.js"), "v2");
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-aqm", "v2"], { cwd: work });
  execFileSync("git", ["push", "--quiet", repo, "HEAD:current"], { cwd: work });
  await service.pushGit(fresh.id, async () => ({ result: true, ok: true }));
  assert.deepEqual(applied, ["v1", "v2"]);
  await service.rollbackDeployment(fresh.id, 1);
  assert.deepEqual(applied, ["v1", "v2", "v1"]);
  assert.equal(await service.reapIdleDeployments(60_000, Date.now() + 1_000_000), 1);
  assert.deepEqual(destroyed, [`modern:${fresh.id}`]);
  assert.equal((await store.get(old.id))!.status, "running");
  await service.archiveDeployment(old.id);
  assert.equal((await store.get(old.id))!.endpoint, null);
  assert.deepEqual(destroyed, [`modern:${fresh.id}`, `legacy:${old.id}`]);
  await service.restoreDeployment(old.id);
  assert.equal(reconciles, 2);
  assert.equal((await store.get(old.id))!.endpoint!.host, "legacy.flycast");
});
