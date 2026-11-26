import { test } from "node:test";
import assert from "node:assert/strict";
import { appCredentialGrants, appCredentialSlugs } from "../src/deploy/app-credentials.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { deployRef, encodeRef, serviceCredRef } from "../src/acl/resource-ref.ts";
import type { PublicServiceCredential } from "../src/credentials/keychain.ts";
import { scopeId, personalScope } from "../src/types.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { testTenant as tenant } from "./support/test-tenant.ts";

const ORG = scopeId("org", "default-org");
const DEVS = scopeId("team", "devs");
const cred = (slug: string, over: Partial<PublicServiceCredential> = {}): PublicServiceCredential => ({
  slug,
  name: slug,
  delivery: "broker",
  host: `${slug}.example`,
  deployments: true,
  enabled: true,
  hasSecret: true,
  updatedAt: 1,
  ...over,
});

test("a published app borrows a credential only when one grant covers its publisher and everyone it is shared with", async () => {
  const grants = createPostgresGrantStore(testDatabaseUrl());
  const acl = createAclStore(grants);
  const grant = (ownerScopeId: string, ref: string, granteeScopeId: string) =>
    grants.put(tenant, { ownerScopeId, ref, granteeScopeId, permission: "read", grantedBy: "admin" });
  for (const slug of ["acme-data", "off-for-apps", "disabled", "no-secret", "env-only"])
    await grant(ORG, encodeRef(serviceCredRef(slug)), ORG);
  await grant(ORG, encodeRef(serviceCredRef("e2b")), DEVS);
  await grant(ORG, encodeRef(serviceCredRef("finance-api")), personalScope("cfo"));
  const access = {
    tenant,
    orgScope: ORG,
    acl,
    teams: {
      forTurn: async () => [
        { id: "devs", name: "Devs", isolatedInOpen: false, configured: false, present: new Set(["ada", "bo"]) },
      ],
    },
  };
  const app = { id: "app-1", ownerScopeId: personalScope("ada"), createdBy: "ada" };
  const slugs = async (over = {}) =>
    appCredentialSlugs(
      [
        cred("acme-data"),
        cred("e2b"),
        cred("finance-api"),
        cred("ungranted"),
        cred("off-for-apps", { deployments: false }),
        cred("disabled", { enabled: false }),
        cred("no-secret", { hasSecret: false }),
        cred("env-only", { delivery: "env", envKey: "ENV_ONLY" }),
      ],
      await appCredentialGrants({ ...app, ...over }, access),
    );
  assert.deepEqual(await slugs(), ["acme-data", "e2b"]);
  await grant(app.ownerScopeId, encodeRef(deployRef(app.id)), personalScope("bo"));
  assert.deepEqual(await slugs(), ["acme-data", "e2b"], "sharing with another dev keeps the dev credential");
  assert.deepEqual(await slugs({ public: true }), ["acme-data"], "a public app borrows only org-wide credentials");
  assert.deepEqual(await slugs({ createdBy: "cy" }), ["acme-data"], "the publisher must be covered too");
  await grant(app.ownerScopeId, encodeRef(deployRef(app.id)), personalScope("cy"));
  assert.deepEqual(await slugs(), ["acme-data"], "sharing outside the team drops the dev credential");
  assert.deepEqual(await slugs({ ownerScopeId: DEVS }), ["acme-data", "e2b"], "a home the grant names is covered");
});
