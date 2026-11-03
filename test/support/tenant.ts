import { TENANT_HEADER } from "../../plugins/chassis/src/source-auth-sign.ts";
import { scopeId } from "../../src/types.ts";
import { testTenants } from "./test-tenants.ts";

export const [TEST_TENANT, OTHER_TENANT] = testTenants();
export const TENANT_HEADERS = { [TENANT_HEADER]: TEST_TENANT };
export const TEST_ROOT_SCOPE = scopeId("org", TEST_TENANT);
