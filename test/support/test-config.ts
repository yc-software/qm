import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../../src/config.ts";
import { TEST_ADMIN_GRANTS, testMigratedDatabaseUrl } from "./test-database.ts";

export const TEST_CAPABILITY_SECRET = "test-capability-key-distinct-from-ingress-auth";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({}),
    databaseUrl: overrides.databaseUrl ?? testMigratedDatabaseUrl(),
    adminGrants: TEST_ADMIN_GRANTS,
    databasePoolMax: 4,
    databaseDirectPoolMax: 8,
    securityScreen: "enforce",
    port: 0,
    pluginSkillDirs: [],
    memoryCaptureQuietMs: 0,
    shutdownDrainMs: 250,
    turnLeaseWaitMs: 50,
    connectorSecretKey: "test-connector-key-distinct-from-ingress-auth",
    capabilitySecret: TEST_CAPABILITY_SECRET,
    sandboxBackend: "sprites" as const,
    spritesSandbox: { token: "test-token" },
    dataDir: overrides.dataDir ?? mkdtempSync(join(tmpdir(), "qm-test-")),
    ...overrides,
  };
}
