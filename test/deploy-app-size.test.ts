import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { scopeId } from "../src/types.ts";

function service(maxAppBytes?: number) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-app-size-"));
  let applies = 0;
  const deploy = createDeployService({
    deployStore: createDeployStore({ git: { repoRoot: join(dir, "repos") } }),
    provider: {
      profile: { managedScaleToZero: false, ...(maxAppBytes ? { maxAppBytes } : {}) },
      apply: async () => {
        applies++;
        return { host: "127.0.0.1", port: 1 };
      },
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: join(dir, "deploy"),
  });
  return { deploy, applies: () => applies };
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

test("providers without a cap accept any size", async () => {
  const { deploy, applies } = service();
  await deploy.deploy({ ...owner, files: [{ path: "a.bin", data: new Uint8Array(1024 * 1024) }] });
  assert.equal(applies(), 1);
});
