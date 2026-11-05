import assert from "node:assert/strict";
import test from "node:test";
import { createAclStore, type GrantPersistence } from "../src/acl/acl-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { type FileArtifactRef } from "../src/files/file-artifact-store.ts";
import { entitledScopes } from "../src/resolution/context-filter.ts";
import type { Grant, Principal } from "../src/types.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { allGrants } from "./support/acl-grants.ts";

const owner = "personal:alice";
const recipient = "personal:bob";
const org = "org:default-org";
const bob: Principal = { id: "bob", type: "internal", teamIds: [] };
const grant: Grant = {
  ownerScopeId: owner,
  ref: "F1",
  granteeScopeId: recipient,
  grantedBy: "alice",
  permission: "read",
};

async function fixture() {
  const files = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  await files.put({
    id: "F1",
    ownerScopeId: owner,
    createdBy: "alice",
    name: "report.md",
    path: "reports/report.md",
    mimetype: "text/markdown",
    data: Buffer.from("hello"),
    direction: "out",
  });
  const url = testDatabaseUrl();
  return {
    files,
    grants: () => allGrants(url),
    acl: createAclStore(createPostgresGrantStore(url), {
      resolveFiles: (refs) => files.resolveByIds(refs),
    }),
  };
}

test("file grants require a real, enabled Files ID owned by the granting scope", async () => {
  const { files, acl, grants } = await fixture();
  for (const ref of ["reports/report.md", "report.md", "artifacts/F1/report.md", "missing"]) {
    await assert.rejects(acl.grant({ ...grant, ref }), /put the file in Files first using POST \/v1\/files\/uploads/);
  }
  await assert.rejects(
    acl.grant({ ...grant, ownerScopeId: recipient, grantedBy: "bob" }),
    /owned by the granting scope/,
  );
  await files.setEnabled("F1", false);
  await assert.rejects(acl.grant(grant), /enabled Files record ID/);
  assert.deepEqual(await grants(), []);
  await files.setEnabled("F1", true);
  await acl.grant(grant);
  assert.deepEqual(await grants(), [grant]);
});

test("missing Files resolver fails closed for grants and replacement grants", async () => {
  const url = testDatabaseUrl();
  const acl = createAclStore(createPostgresGrantStore(url));
  await assert.rejects(acl.grant(grant), /Files record ID/);
  await assert.rejects(acl.replaceGrantsIfCurrent(owner, "F1", [], [grant], "alice"), /Files record ID/);
  assert.deepEqual(await allGrants(url), []);
});

test("conditional replacement validates file grants before changing persisted access", async () => {
  const { files, acl, grants } = await fixture();
  await acl.grant(grant);
  const replacement: Grant = { ...grant, permission: "write" };
  await files.setEnabled("F1", false);
  await assert.rejects(
    acl.replaceGrantsIfCurrent(owner, "F1", [grant], [replacement], "alice"),
    /enabled Files record ID/,
  );
  assert.deepEqual(await grants(), [grant]);
  await files.setEnabled("F1", true);
  assert.equal(await acl.replaceGrantsIfCurrent(owner, "F1", [grant], [replacement], "alice"), true);
  assert.deepEqual(await grants(), [replacement]);
  await files.delete("F1");
  assert.equal(await acl.replaceGrantsIfCurrent(owner, "F1", [replacement], [], "alice"), true);
});

test("shared handles use the Files name and ID and disappear when the file is disabled or deleted", async () => {
  const { files, acl } = await fixture();
  await acl.grant(grant);
  const expected = [{ handlePath: "shared/report.md", fileId: "F1", ownerScopeId: owner, permission: "read" }];
  assert.deepEqual(await acl.handlesFor([recipient]), expected);
  assert.deepEqual(await acl.handlesForAudience([bob], recipient, org, entitledScopes), expected);
  assert.deepEqual(await acl.handlesForAudience([], recipient, org, entitledScopes), []);
  assert.deepEqual(
    await acl.handlesForAudience(
      [bob, { id: "outsider", type: "internal", teamIds: [] }],
      "channel:C1",
      org,
      entitledScopes,
    ),
    [],
  );
  for (const remove of [() => files.setEnabled("F1", false), () => files.delete("F1")]) {
    await remove();
    assert.deepEqual(await acl.handlesFor([recipient]), []);
    assert.deepEqual(await acl.handlesForAudience([bob], recipient, org, entitledScopes), []);
  }
});

test("legacy paths, missing Files records and wrong-owner references never produce handles", async () => {
  const { files } = await fixture();
  const persist: GrantPersistence = {
    find: async () => [
      { ...grant, ref: "reports/report.md" },
      { ...grant, ref: "missing" },
      { ...grant, ownerScopeId: org },
    ],
    put: async () => assert.fail("read-only fixture"),
    remove: async () => assert.fail("read-only fixture"),
    replaceForResourceIfCurrent: async () => assert.fail("read-only fixture"),
  };
  for (const opts of [{}, { resolveFiles: (refs: readonly FileArtifactRef[]) => files.resolveByIds(refs) }]) {
    const acl = createAclStore(persist, opts);
    assert.deepEqual(await acl.handlesFor([recipient]), []);
    assert.deepEqual(await acl.handlesForAudience([bob], recipient, org, entitledScopes), []);
  }
});
