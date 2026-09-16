import "./auto-fake-sprites.ts";
import type { AddressInfo } from "node:net";
import { buildApp } from "../../src/wiring.ts";
import { createInsecureTestServer } from "../../src/api/server.ts";
import { migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { testConfig } from "./test-config.ts";

const config = testConfig({
  dataDir: process.env.HOME,
  databaseUrl: process.env.DATABASE_URL,
  sessionStore: "postgres",
  runStore: "postgres",
  backgroundWorkEnabled: false,
});
const built = buildApp(config);
await migrateRegisteredPgSchemas(config.databaseUrl);
await built.deploymentLayerReady;
await built.app.upsertDirectory([{ principalId: "owner", displayName: "Owner", type: "internal" }]);
const server = createInsecureTestServer(built.app, {});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.send?.({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
