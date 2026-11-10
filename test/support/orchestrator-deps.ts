import { createPostgresErrorLog } from "../../src/admin/postgres-error-log.ts";
import { createDeliveryStore } from "../../src/delivery/delivery-store.ts";
import { createPostgresDirectoryStore } from "../../src/directory/postgres-directory-store.ts";
import { createMemoryDurableByteStore } from "../../src/files/durable-byte-store.ts";
import { createPostgresRunSignalStore } from "../../src/runs/postgres-run-signal-store.ts";
import { createTurnStream } from "../../src/runs/turn-stream.ts";
import { createPostgresToolOutputStore } from "../../src/sessions/tool-output.ts";
import { singleProcessDeps } from "./single-process.ts";
import { testConfig } from "./test-config.ts";
import { testDatabaseUrl, testPgPool } from "./test-database.ts";

export const orchestratorTestDeps = () => {
  const config = testConfig();
  return {
    ...singleProcessDeps(),
    errors: createPostgresErrorLog(testDatabaseUrl()),
    signals: createPostgresRunSignalStore(testDatabaseUrl()),
    turnStream: createTurnStream(),
    deliveries: createDeliveryStore(),
    directory: createPostgresDirectoryStore(testDatabaseUrl()),
    toolOutput: createPostgresToolOutputStore({ pool: testPgPool(), bytesFor: () => createMemoryDurableByteStore() }),
    defaultTurnWallClockMs: config.turnWallClockMs,
    execTimeoutMs: config.execTimeoutDefaultMs,
    execTimeoutCeilingMs: config.execTimeoutMaxMs,
    backgroundJobTtlMs: config.backgroundJobTtlMs,
    backgroundJobTtlMaxMs: config.backgroundJobTtlMaxMs,
  };
};
