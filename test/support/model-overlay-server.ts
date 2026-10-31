import "./auto-fake-sprites.ts";
import type { AddressInfo } from "node:net";
import { serverDeps } from "../../src/wiring.ts";
import { createInsecureTestServer } from "../../src/api/server.ts";
import { buildApp, testTenantSettings } from "./build-app.ts";
import { testConfig } from "./test-config.ts";

const config = testConfig({
  databaseUrl: process.env.MODEL_OVERLAY_TEST_DATABASE_URL,
  harness: "pi",
});
const built = buildApp(config, {
  modelCredentialFetch: async () => Response.json({ data: [] }),
  tenantSettings: testTenantSettings({
    OPENAI_BASE_URL: `${process.env.MODEL_OVERLAY_TEST_UPSTREAM}/v1`,
    PI_MODEL: "overlay-pg-model",
    ADMIN_GRANTS: "admin-alice:org_admin",
  }),
});
if (!(await built.modelCredentials.resolve("openai")))
  await built.modelCredentials.set("openai", "local-test-key", "admin-alice");
await built.tenantSettings.get();
const server = createInsecureTestServer(built.app, serverDeps(config, built));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.send?.({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
