import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/app.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { scopeId } from "../src/types.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";

function svc() {
  const deployStore = createDeployStore();
  const acl = createAclStore();
  const deploy = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 20000 }),
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl,
    deployDir: mkdtempSync(join(tmpdir(), "rn-")),
  });
  return { deploy, deployStore };
}

const make = (deploy: ReturnType<typeof svc>["deploy"], name: string) =>
  deploy.deploy({ ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "x", files: [], name });

test("renameDeployment moves the URL slug by id, keeping the immutable id", async () => {
  const s = svc();
  const d = await make(s.deploy, "old-slug");
  const r = await s.deploy.renameDeployment(d.id, "new-slug");
  assert.equal(r.id, d.id, "same deployment");
  assert.equal(r.name, "new-slug");
  assert.equal(await s.deployStore.getByName("old-slug"), null, "old slug no longer resolves");
  assert.equal((await s.deployStore.getByName("new-slug"))!.id, d.id);
});

test("renameDeployment rejects a taken slug, an invalid slug, and an unknown id", async () => {
  const s = svc();
  const a = await make(s.deploy, "alpha");
  await make(s.deploy, "beta");
  await assert.rejects(() => s.deploy.renameDeployment(a.id, "beta"), /name taken/);
  await assert.rejects(() => s.deploy.renameDeployment(a.id, "Bad_Slug"), /invalid deployment name/);
  await assert.rejects(() => s.deploy.renameDeployment("nope", "ok-slug"), /unknown deployment/);
});

test("setDeploymentDisplayName sets the label, then clears it (independent of the slug)", async () => {
  const s = svc();
  const d = await make(s.deploy, "my-app");
  const set = await s.deploy.setDeploymentDisplayName(d.id, "My Cool App");
  assert.equal(set.displayName, "My Cool App");
  assert.equal(set.name, "my-app", "the URL slug is untouched");
  const cleared = await s.deploy.setDeploymentDisplayName(d.id, "");
  assert.equal(cleared.displayName, undefined, "empty clears the label (falls back to name/id)");
  assert.equal(cleared.name, "my-app");
});

test("HTTP: the /name (slug) route does not shadow /display-name", async () => {
  const s = svc();
  const app = createApp({ deploy: s.deploy } as unknown as Parameters<typeof createApp>[0]);
  const identitySecret = "deployment-route-identity-secret";
  const server = createInsecureTestServer(app, {
    portalIdentitySecret: identitySecret,
    requireSignedPortalIdentity: true,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const identity = await mintSignedPayload({ p: "U1", exp: Date.now() + 60_000 }, identitySecret);
  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-portal-identity": identity },
      body: JSON.stringify(body),
    });
  try {
    const d = await make(s.deploy, "my-app");
    const dn = await post(`/v1/deployments/${d.id}/display-name`, { displayName: "Pretty" });
    assert.equal(dn.status, 200);
    const dnBody = (await dn.json()) as { deployment: { name?: string; displayName?: string } };
    assert.equal(dnBody.deployment.displayName, "Pretty");
    assert.equal(dnBody.deployment.name, "my-app", "the URL slug is untouched");
    const rn = await post(`/v1/deployments/${d.id}/name`, { name: "new-slug" });
    assert.equal(rn.status, 200);
    const rnBody = (await rn.json()) as { deployment: { name?: string; displayName?: string } };
    assert.equal(rnBody.deployment.name, "new-slug");
    assert.equal(rnBody.deployment.displayName, "Pretty");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("setDeploymentDisplayName rejects an over-long or control-char label, and an unknown id", async () => {
  const s = svc();
  const d = await make(s.deploy, "app");
  await assert.rejects(() => s.deploy.setDeploymentDisplayName(d.id, "x".repeat(61)), /too long/);
  await assert.rejects(() => s.deploy.setDeploymentDisplayName(d.id, "badname"), /control characters/);
  await assert.rejects(() => s.deploy.setDeploymentDisplayName("nope", "label"), /unknown deployment/);
});
