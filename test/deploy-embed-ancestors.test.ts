import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { scopeId } from "../src/types.ts";

function svc() {
  const deployStore = createDeployStore();
  const deploy = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 5000 }),
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "embed-ancestors-")),
  });
  return { deploy, deployStore };
}

const owner = { ownerScopeId: scopeId("personal", "U1"), createdBy: "U1" };
const files = [{ path: "server.js", data: new TextEncoder().encode("listen") }];
const ancestors = ["https://internal.example.com", "https://mail.example.com"];

test("publish sets embed ancestors, a republish that omits them keeps them, and [] clears them", async () => {
  const { deploy } = svc();
  const created = await deploy.deployOrUpdate({
    ...owner,
    name: "panel",
    entrypoint: "node server.js",
    files,
    embedAncestors: ancestors,
  });
  assert.deepEqual(created.embedAncestors, ancestors);

  const kept = await deploy.deployOrUpdate({ ...owner, name: "panel", files });
  assert.deepEqual(kept.embedAncestors, ancestors, "a republish without the field leaves the setting alone");
  assert.equal(kept.currentVersion, 2);

  const cleared = await deploy.deployOrUpdate({ ...owner, name: "panel", files, embedAncestors: [] });
  assert.deepEqual(cleared.embedAncestors, []);
});

test("embed ancestors can be changed without a new version, through rename and rollback too", async () => {
  const { deploy } = svc();
  const first = await deploy.deployOrUpdate({ ...owner, name: "panel", entrypoint: "node server.js", files });
  await deploy.deployOrUpdate({ ...owner, name: "panel", files });

  const renamed = await deploy.deployOrUpdate({
    ...owner,
    name: "panel2",
    renameFrom: "panel",
    embedAncestors: ancestors,
  });
  assert.equal(renamed.id, first.id);
  assert.deepEqual(renamed.embedAncestors, ancestors);
  assert.equal(renamed.currentVersion, 2, "setting the list is not a redeploy");

  const rolled = await deploy.deployOrUpdate({ ...owner, name: "panel2", rollbackTo: 1, embedAncestors: [] });
  assert.deepEqual(rolled.embedAncestors, []);
});

test("an invalid embed ancestor is refused before anything is published", async () => {
  const { deploy, deployStore } = svc();
  await assert.rejects(
    deploy.deployOrUpdate({
      ...owner,
      name: "panel",
      entrypoint: "node server.js",
      files,
      embedAncestors: ["http://x.example.com"],
    }),
    /embedAncestors must be an array of up to 16 https origins/,
  );
  assert.equal(await deployStore.getByName("panel"), null);

  const d = await deploy.deploy({ ...owner, entrypoint: "node server.js", files });
  await assert.rejects(deploy.setDeploymentEmbedAncestors(d.id, ["*"]), /embedAncestors must be an/);
  assert.equal((await deployStore.get(d.id))!.embedAncestors, undefined);
});
