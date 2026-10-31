import { pathToFileURL } from "node:url";
import { bindTestTenant } from "./tenant.ts";

bindTestTenant();
await import(pathToFileURL(process.env.QM_TEST_FILE!).href);
