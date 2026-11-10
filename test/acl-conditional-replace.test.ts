import assert from "node:assert/strict";
import test from "node:test";
import { createAclStore } from "../src/acl/acl-store.ts";
import type { Grant } from "../src/types.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { testTenant as tenant } from "./support/test-tenant.ts";

const owner = "org:default-org";
const ref = "service-cred:k";

test("conditional grant compensation preserves a newer full-tuple write", async () => {
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const original: Grant = {
    ownerScopeId: owner,
    ref,
    granteeScopeId: owner,
    permission: "write",
    grantedBy: "original-governor",
  };
  const forward: Grant = {
    ownerScopeId: owner,
    ref,
    granteeScopeId: "personal:alice",
    permission: "read",
    grantedBy: "editor",
  };
  const concurrent: Grant = {
    ownerScopeId: owner,
    ref,
    granteeScopeId: "team:security",
    permission: "write",
    grantedBy: "concurrent-governor",
  };
  await acl.grant(tenant, original);
  assert.equal(await acl.replaceGrantsIfCurrent(tenant, owner, ref, [original], [forward], "editor"), true);
  await acl.grant(tenant, concurrent);

  assert.equal(await acl.replaceGrantsIfCurrent(tenant, owner, ref, [forward], [original], "editor"), false);
  assert.deepEqual(await acl.grantsFor(tenant, owner, ref), [forward, concurrent]);
});
