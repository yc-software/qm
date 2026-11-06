import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { buildApp } from "../src/wiring.ts";
import type { SpreadsheetCalculationEngine } from "../src/finny/deterministic-spreadsheet-worker.ts";
import { stopAtEnd } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

const finny = {
  signingSecret: "finny-test-secret",
  findingPolicy: { id: "test", maxFindings: 4, maxCodeLength: 40, maxMessageLength: 200 },
  maxReworks: 2,
  workerGrantTtlMs: 60_000,
};

const configuredFinny = loadConfig({
  FINNY_ENABLED: "true",
  DATABASE_URL: "postgres://qm@localhost/qm",
  PUBLIC_WEB_URL: "https://qm.example",
  FINNY_SIGNING_SECRET: "finny-signing-secret-0123456789abcdef",
  FINNY_FINDING_POLICY_VERSION: "finance-audit.v1",
  FINNY_MAX_FINDINGS: "4",
  FINNY_MAX_FINDING_CODE_LENGTH: "40",
  FINNY_MAX_FINDING_MESSAGE_LENGTH: "200",
  FINNY_MAX_REWORKS: "2",
  FINNY_WORKER_GRANT_TTL_MS: "60000",
  FINNY_SPREADSHEET_ENGINE_URL: "https://spreadsheet-engine.example/evaluate",
  FINNY_SPREADSHEET_ENGINE_NAME: "libreoffice-service",
  FINNY_SPREADSHEET_ENGINE_VERSION: "24.2",
  FINNY_SPREADSHEET_ENGINE_TIMEOUT_MS: "30000",
  FINNY_SPREADSHEET_ENGINE_MAX_RESPONSE_BYTES: "1048576",
}).finny!;

const engine: SpreadsheetCalculationEngine = {
  name: "approved-test-engine",
  version: "1",
  async evaluate() {
    return [];
  },
};

test("Finny-enabled build fails before startup without an approved spreadsheet engine", () => {
  assert.throws(
    () => buildApp(testConfig({ finny: finny as any, shutdownDrainMs: 5_000 })),
    /spreadsheet calculation engine/i,
  );
});

test("Finny-enabled build accepts an explicitly injected spreadsheet engine", () => {
  const built = stopAtEnd(
    buildApp(testConfig({ finny: finny as any, shutdownDrainMs: 5_000 }), { spreadsheetCalculationEngine: engine }),
  );
  assert.ok(built.finnyCurrentJobReader);
});

test("stock Finny wiring selects the environment-configured HTTP engine", () => {
  const built = stopAtEnd(buildApp(testConfig({ finny: configuredFinny, shutdownDrainMs: 5_000 })));
  assert.ok(built.finnyCurrentJobReader);
});

test("ordinary builds remain unaffected without a spreadsheet engine", () => {
  const built = stopAtEnd(buildApp(testConfig({ shutdownDrainMs: 5_000 })));
  assert.equal(built.finnyCurrentJobReader, undefined);
});
