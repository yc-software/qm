import assert from "node:assert/strict";
import test from "node:test";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import type { Grant } from "../src/types.ts";

const base = { ownerScopeId: "org:default-org", granteeScopeId: "personal:alice", permission: "read" } as const;

async function regrant(acl: ReturnType<typeof createAclStore>, ref: string): Promise<Grant[]> {
  await acl.grant({ ...base, ref, grantedBy: "first-admin" });
  await acl.grant({ ...base, ref, grantedBy: "second-admin" });
  return acl.grantsFor(base.ownerScopeId, ref);
}

test("re-granting the same access records the latest granter (in-memory store)", async () => {
  const acl = createAclStore(undefined, { manages: async () => true });
  const grants = await regrant(acl, "service-cred:regrant-memory");
  assert.deepEqual(
    grants.map((g) => g.grantedBy),
    ["second-admin"],
  );
});

test(
  "re-granting the same access records the latest granter (Postgres store)",
  { skip: !process.env.DATABASE_URL && "requires Postgres" },
  async () => {
    const persist = createPostgresGrantStore(process.env.DATABASE_URL!);
    const acl = createAclStore(persist, { manages: async () => true });
    const ref = `service-cred:regrant-${Date.now()}`;
    try {
      const grants = await regrant(acl, ref);
      assert.deepEqual(
        grants.map((g) => g.grantedBy),
        ["second-admin"],
      );
    } finally {
      await persist.remove({ ...base, ref, grantedBy: "second-admin" });
    }
  },
);
