import assert from "node:assert/strict";
import test from "node:test";
import { createAclStore } from "../src/acl/acl-store.ts";
import type { Grant } from "../src/types.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { withTenant } from "../src/tenants/context.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { testTenants } from "./support/test-tenants.ts";
import { inTestTenant } from "./support/test-tenants.ts";

const owner = "org:default-org";
const ref = "service-cred:k";

test("conditional grant compensation preserves a newer full-tuple write", () =>
  inTestTenant(async () => {
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
  }));

test("cached grants are kept per tenant", () =>
  inTestTenant(async () => {
    const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
    const [, other] = testTenants();
    const grant: Grant = {
      ownerScopeId: owner,
      ref: "service-cred:t",
      granteeScopeId: owner,
      permission: "read",
      grantedBy: "a",
    };
    await withTenant(other, () => acl.grantsFor(owner, grant.ref));
    await acl.grant(grant);
    assert.deepEqual(await acl.grantsFor(owner, grant.ref), [grant]);
    assert.deepEqual(await withTenant(other, () => acl.grantsFor(owner, grant.ref)), []);
  }));
