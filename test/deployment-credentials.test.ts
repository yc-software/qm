import { test } from "node:test";
import assert from "node:assert/strict";
import { deploymentCredentialSlugs } from "../src/deploy/deployment-credentials.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { encodeRef, serviceCredRef } from "../src/acl/resource-ref.ts";
import type { PublicServiceCredential } from "../src/credentials/keychain.ts";
import { scopeId } from "../src/types.ts";

const ORG = scopeId("org", "default-org");
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

test("a published app gets only enabled broker credentials that are switched on for apps AND granted org-wide", async () => {
  const acl = createAclStore();
  const grant = (slug: string, grantee: string) =>
    acl.grant({
      ownerScopeId: ORG,
      ref: encodeRef(serviceCredRef(slug)),
      granteeScopeId: grantee,
      permission: "read",
      grantedBy: "admin",
    });
  await grant("yc-data", ORG);
  await grant("finance-api", "personal:cfo");
  await grant("off-for-apps", ORG);
  await grant("disabled", ORG);
  await grant("no-secret", ORG);
  await grant("env-only", ORG);
  const slugs = await deploymentCredentialSlugs(
    [
      cred("yc-data"),
      cred("finance-api"),
      cred("ungranted"),
      cred("off-for-apps", { deployments: false }),
      cred("disabled", { enabled: false }),
      cred("no-secret", { hasSecret: false }),
      cred("env-only", { delivery: "env", envKey: "ENV_ONLY" }),
    ],
    ORG,
    acl,
  );
  assert.deepEqual(
    slugs,
    ["yc-data"],
    "a personal grant, no grant, a flipped switch, or an unusable record never reaches an app",
  );
});
