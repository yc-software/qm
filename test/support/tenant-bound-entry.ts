import { pathToFileURL } from "node:url";
import { registerOwnerLogin } from "../../src/persistence/pg-pool.ts";
import { enterTenant } from "../../src/tenants/context.ts";
import { TEST_TENANT } from "./tenant-seed.ts";

if (process.env.DATABASE_URL) registerOwnerLogin(process.env.DATABASE_URL, process.env.DATABASE_URL);
enterTenant(TEST_TENANT);
await import(pathToFileURL(process.env.QM_TEST_FILE!).href);
