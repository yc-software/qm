import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withTenant } from "../../src/tenants/context.ts";
import { testTenants } from "./test-tenants.ts";

const file = process.argv[2];
if (!file) throw new Error("Pass the test file to run");
await withTenant(testTenants()[0], () => import(pathToFileURL(resolve(file)).href));
