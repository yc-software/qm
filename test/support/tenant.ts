import { TENANT_HEADER } from "../../plugins/chassis/src/source-auth-sign.ts";
import { enterTenant } from "../../src/tenants/context.ts";

export const TEST_TENANT = "00000000-0000-4000-8000-000000000001";
export const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";
export const TENANT_HEADERS = { [TENANT_HEADER]: TEST_TENANT };

export function bindTestTenant(): void {
  enterTenant(TEST_TENANT);
}
