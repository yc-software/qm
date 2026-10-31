import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { type FileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { scopeId, type Grant } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";

const owner = scopeId("personal", "U1");
const carol = scopeId("personal", "U2");
const org = scopeId("org", "default-org");
const grant = (over: Partial<Grant> = {}): Grant => ({
  ownerScopeId: owner,
  ref: "F1",
  granteeScopeId: carol,
  permission: "read",
  grantedBy: "U1",
  ...over,
});

async function putFile(files: FileArtifactStore, ownerScopeId: string) {
  await files.put({
    id: "F1",
    ownerScopeId,
    createdBy: "U1",
    name: "redline.md",
    path: "artifacts/F1/redline.md",
    mimetype: "text/markdown",
    data: Buffer.from("hello"),
    direction: "out",
  });
}

async function fileAcl(ownerScopeId: string) {
  const files = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  await putFile(files, ownerScopeId);
  return createAclStore(createPostgresGrantStore(testDatabaseUrl()), {
    resolveFiles: (refs) => files.resolveByIds(refs),
  });
}

test("revoke has the same owner check as grant: a non-owner cannot revoke a personal-scope grant", async () => {
  const acl = await fileAcl(owner);
  await acl.grant(grant());
  await assert.rejects(acl.revoke(owner, "F1", carol, "U2"), /only a manager/);
  assert.equal((await acl.grantsFor(owner, "F1")).length, 1, "the grant survives the rejected revoke");
  await acl.revoke(owner, "F1", carol, "U1");
  assert.equal((await acl.grantsFor(owner, "F1")).length, 0, "the owner can revoke");
});

test("org-owned grants have no single owner, so revoke is not owner-gated (same as grant)", async () => {
  const acl = await fileAcl(org);
  await acl.grant(grant({ ownerScopeId: org, grantedBy: "admin" }));
  await acl.revoke(org, "F1", carol, "someone-else");
  assert.equal((await acl.grantsFor(org, "F1")).length, 0);
});

test("POST /v1/grants/revoke requires revokedBy and rejects a non-owner", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "revoke-")) }));
  await putFile(built.files, owner);
  const server = createInsecureTestServer(built.app);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/v1/grants", grant())).status, 200);

    const missing = await post("/v1/grants/revoke", { ownerScopeId: owner, ref: "F1", granteeScopeId: carol });
    assert.equal(missing.status, 400, "revokedBy is required");

    const forged = await post("/v1/grants/revoke", {
      ownerScopeId: owner,
      ref: "F1",
      granteeScopeId: carol,
      revokedBy: "U2",
    });
    assert.equal(forged.status, 400);
    assert.equal(((await forged.json()) as { error: string }).error, "revoke_failed");
    assert.equal((await built.acl.grantsFor(owner, "F1")).length, 1, "the grant survives");

    const legit = await post("/v1/grants/revoke", {
      ownerScopeId: owner,
      ref: "F1",
      granteeScopeId: carol,
      revokedBy: "U1",
    });
    assert.equal(legit.status, 200);
    assert.equal((await built.acl.grantsFor(owner, "F1")).length, 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
