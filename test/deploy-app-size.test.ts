import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { scopeId } from "../src/types.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { testDeployBackings, testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";

function service(maxAppBytes?: number) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-app-size-"));
  let applies = 0;
  const store = createDeployStore(testDeployBackings({ git: { repoRoot: join(dir, "repos") } }));
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore: store,
    provider: {
      profile: { managedScaleToZero: false, ...(maxAppBytes ? { maxAppBytes } : {}) },
      apply: async () => {
        applies++;
        return { host: "127.0.0.1", port: 1 };
      },
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl())),
    deployDir: join(dir, "deploy"),
  });
  return { deploy, store, applies: () => applies };
}

const owner = { ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "node server.js" };

test("a provider's app size cap rejects oversized publishes and redeploys before anything is applied", async () => {
  const { deploy, applies } = service(10);
  await assert.rejects(
    deploy.deploy({
      ...owner,
      files: [
        { path: "a.bin", data: new Uint8Array(6) },
        { path: "b.txt", data: "hello" },
      ],
    }),
    /^Error: the app is too large to publish: 11 bytes, maximum 10 bytes/,
  );
  assert.equal(applies(), 0);
  const d = await deploy.deploy({ ...owner, files: [{ path: "a.txt", data: "0123456789" }] });
  assert.equal(applies(), 1);
  await assert.rejects(
    deploy.redeploy(d.id, { entrypoint: "node server.js", files: [{ path: "a.txt", data: "0123456789!" }] }),
    /too large to publish: 11 bytes/,
  );
  assert.equal(applies(), 1);
});

test("the cap also blocks an oversized version pushed to the deployment's git repo", async () => {
  const { deploy, store, applies } = service(10);
  const d = await deploy.deploy({ ...owner, files: [{ path: "a.txt", data: "0123456789" }] });
  const work = mkdtempSync(join(tmpdir(), "deploy-app-size-push-"));
  execFileSync("git", ["clone", "--quiet", (await deploy.gitRepoPath(d.id))!, work]);
  writeFileSync(join(work, "a.txt"), "0123456789!");
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-aqm", "big"], { cwd: work });
  execFileSync("git", ["push", "--quiet", (await deploy.gitRepoPath(d.id))!, "HEAD:current"], { cwd: work });
  await deploy.pushGit(d.id, async () => ({ result: true, ok: true }));
  assert.equal(applies(), 1);
  const after = (await store.get(d.id))!;
  assert.equal(after.currentVersion, 1);
  assert.equal(after.versions.length, 1);
});
