import assert from "node:assert/strict";
import test from "node:test";
import { createAclStore } from "../src/acl/acl-store.ts";
import type { Grant } from "../src/types.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { TEST_ROOT_SCOPE } from "./support/tenant.ts";

const owner = TEST_ROOT_SCOPE;
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
  await acl.grant(original);
  assert.equal(await acl.replaceGrantsIfCurrent(owner, ref, [original], [forward], "editor"), true);
  await acl.grant(concurrent);

  assert.equal(await acl.replaceGrantsIfCurrent(owner, ref, [forward], [original], "editor"), false);
  assert.deepEqual(await acl.grantsFor(owner, ref), [forward, concurrent]);
});
