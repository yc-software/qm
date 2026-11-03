import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../../src/config.ts";
import { ownerUrlOf, testMigratedDatabaseUrl } from "./test-database.ts";

export const TEST_CAPABILITY_SECRET = "test-capability-key-distinct-from-ingress-auth";

export function testConfig(overrides: Partial<Config> = {}): Config {
  const databaseUrl = overrides.databaseUrl ?? testMigratedDatabaseUrl();
  return {
    ...loadConfig({}),
    databaseUrl,
    databaseOwnerUrl: overrides.databaseOwnerUrl ?? ownerUrlOf(databaseUrl),
    port: 0,
    pluginSkillDirs: [],
    memoryCaptureQuietMs: 0,
    shutdownDrainMs: 250,
    connectorSecretKey: "test-connector-key-distinct-from-ingress-auth",
    capabilitySecret: TEST_CAPABILITY_SECRET,
    dataDir: overrides.dataDir ?? mkdtempSync(join(tmpdir(), "qm-test-")),
    ...overrides,
  };
}
