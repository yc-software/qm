import { createAdminService } from "../../src/admin/admin-service.ts";
import type { AdminGrant, AdminGrantStore } from "../../src/admin/admin-grant-store.ts";
import { createPrincipalLinkService, type PrincipalLink } from "../../src/identity/principal-links.ts";
import type { DurableMap } from "../../src/persistence/durable-map.ts";
import { testAdminGrantStore, testAdvisoryLock, testMap } from "./test-database.ts";

export const testGrants = (seed: AdminGrant[] = []) => testAdminGrantStore(seed);

export const testPrincipalLinks = (
  backing: DurableMap<PrincipalLink> = testMap<PrincipalLink>(),
  grants: Pick<AdminGrantStore, "list"> = testGrants(),
) => createPrincipalLinkService(backing, testAdvisoryLock(), grants);

export function testAdmin(
  grants: AdminGrantStore = testAdminGrantStore(),
  opts: { trustedOidcAdminIssuer?: string } = {},
) {
  return createAdminService(grants, { ...opts, principalLinks: testPrincipalLinks(undefined, grants) });
}
