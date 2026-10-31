import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../../src/config.ts";
import { testMigratedDatabaseUrl } from "./test-database.ts";

export const TEST_CAPABILITY_SECRET = "test-capability-key-distinct-from-ingress-auth";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({}),
    databaseUrl: overrides.databaseUrl ?? testMigratedDatabaseUrl(),
    databasePoolMax: 4,
    databaseDirectPoolMax: 8,
    port: 0,
    pluginSkillDirs: [],
    memoryCaptureQuietMs: 0,
    shutdownDrainMs: 250,
    turnLeaseWaitMs: 50,
    connectorSecretKey: "test-connector-key-distinct-from-ingress-auth",
    capabilitySecret: TEST_CAPABILITY_SECRET,
    dataDir: overrides.dataDir ?? mkdtempSync(join(tmpdir(), "qm-test-")),
    ...(overrides.databaseUrl ? { databaseOwnerUrl: overrides.databaseUrl } : {}),
    ...overrides,
  };
}
