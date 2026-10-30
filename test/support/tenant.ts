import { enterTenant } from "../../src/tenants/context.ts";

export const TEST_TENANT = "00000000-0000-4000-8000-000000000001";

export function bindTestTenant(): void {
  enterTenant(TEST_TENANT);
}

export const TEST_ROOT_SCOPE = `org:${TEST_TENANT}`;

export const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";
