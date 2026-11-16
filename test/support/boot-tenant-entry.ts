import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bindBootTenant } from "../../src/tenants/boot.ts";
import { withTenant } from "../../src/tenants/context.ts";
import { TEST_TENANT } from "./test-tenant-id.ts";

const file = process.env.QM_BOOT_TENANT_TEST_FILE;
if (!file) throw new Error("Set QM_BOOT_TENANT_TEST_FILE to the test file to run in the boot tenant");
await bindBootTenant(async () => TEST_TENANT);
await withTenant(TEST_TENANT, () => import(pathToFileURL(resolve(file)).href));
