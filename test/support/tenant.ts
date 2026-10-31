import { before } from "node:test";
import { enterTenant } from "../../src/tenants/context.ts";
import { OTHER_TENANT, seedTenant, seedTestTenants, TEST_TENANT } from "./tenant-seed.ts";

export { OTHER_TENANT, seedTenant, seedTestTenants, TEST_TENANT };

let seeding: Promise<void> | undefined;
let hooked = false;

export function testTenantsSeeded(): Promise<void> {
  const url = process.env.DATABASE_URL;
  return url ? (seeding ??= seedTestTenants(url)) : Promise.resolve();
}

export function bindTestTenant(): void {
  enterTenant(TEST_TENANT);
  if (hooked || !process.env.DATABASE_URL) return;
  hooked = true;
  before(testTenantsSeeded);
}

export function boundUrl(url: string, id = TEST_TENANT): string {
  const bound = new URL(url);
  const options = bound.searchParams.get("options");
  bound.searchParams.set("options", `${options ? `${options} ` : ""}-c qm.tenant_id=${id}`);
  return bound.toString();
}
