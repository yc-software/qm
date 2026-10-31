import { pathToFileURL } from "node:url";
import { enterTenant } from "../../src/tenants/context.ts";
import { TEST_TENANT } from "./tenant.ts";

enterTenant(TEST_TENANT);
await import(pathToFileURL(process.env.QM_TEST_FILE!).href);
