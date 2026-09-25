import "./auto-fake-sprites.ts";
import type { AddressInfo } from "node:net";
import { buildApp, serverDeps } from "../../src/wiring.ts";
import { createInsecureTestServer } from "../../src/api/server.ts";
import { testConfig } from "./test-config.ts";

const config = testConfig({
  providerBaseUrls: { openai: `${process.env.MODEL_OVERLAY_TEST_UPSTREAM}/v1` },
  databaseUrl: process.env.MODEL_OVERLAY_TEST_DATABASE_URL,
  adminGrants: "admin-alice:org_admin",
  harness: "pi",
  modelId: "overlay-pg-model",
  openaiApiKey: "local-test-key",
});
const built = buildApp(config, { modelCredentialFetch: async () => Response.json({ data: [] }) });
const server = createInsecureTestServer(built.app, serverDeps(config, built));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.send?.({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
