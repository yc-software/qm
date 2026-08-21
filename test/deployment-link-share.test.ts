import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/app.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { scopeId } from "../src/types.ts";

async function setup() {
  const acl = createAclStore();
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({
        host: "127.0.0.1",
        port: 19999,
        publicUrl: "https://research-artifact.apps.example/",
      }),
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl,
    deployDir: mkdtempSync(join(tmpdir(), "deployment-link-share-")),
  });
  const directory = createDirectoryStore();
  await directory.replaceChannels(
    [{ channelId: "CRESEARCH", name: "research", isPrivate: true }],
    [
      { channelId: "CRESEARCH", principalId: "U1" },
      { channelId: "CRESEARCH", principalId: "U2" },
    ],
  );
  const app = createApp({
    deploy,
    acl,
    directory,
    sessions: createMemorySessionStore(),
    identity: createIdentityService(),
    publicWebUrl: "https://qm.example",
  } as unknown as Parameters<typeof createApp>[0]);
  const deployment = await app.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    files: [],
    name: "research-artifact",
  });
  return { app, deployment };
}

test("posting an owned deployment URL shares it read-only with the conversation scope", async () => {
  const { app, deployment } = await setup();
  assert.equal((await app.reachDeployment(deployment.id, "U2")).status, "denied");

  await app.ingestSurfaceEvents([
    {
      container: "CRESEARCH",
      ts: "1.0",
      authorId: "U1",
      text: "Here it is: https://research-artifact.apps.example/",
      kind: "channel",
    },
  ]);

  assert.equal((await app.reachDeployment(deployment.id, "U2")).status, "ok");
  assert.deepEqual(await app.deploymentGrantees(deployment.id), [
    { scope: scopeId("channel", "CRESEARCH"), permission: "read" },
  ]);
});

test("trusted /d links share, while lookalike links and non-owner posts do not", async () => {
  const first = await setup();
  await first.app.ingestSurfaceEvents([
    {
      container: "CRESEARCH",
      ts: "1.0",
      authorId: "U1",
      text: "<https://qm.example/d/research-artifact/|open dashboard>",
      kind: "channel",
    },
  ]);
  assert.equal((await first.app.reachDeployment(first.deployment.id, "U2")).status, "ok");

  for (const [authorId, text] of [
    ["U1", "https://attacker.example/d/research-artifact/"],
    ["U2", "https://research-artifact.apps.example/"],
  ]) {
    const { app, deployment } = await setup();
    await app.ingestSurfaceEvents([{ container: "CRESEARCH", ts: "2.0", authorId, text, kind: "channel" }]);
    assert.equal((await app.reachDeployment(deployment.id, "U2")).status, "denied");
  }
});
