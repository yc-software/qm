import { scopeId } from "../../src/types.ts";
import { testTenants } from "./test-tenants.ts";

export const [TEST_TENANT, OTHER_TENANT] = testTenants();
export const TEST_ROOT_SCOPE = scopeId("org", TEST_TENANT);
