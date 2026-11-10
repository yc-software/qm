import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

const enabled = {
  FINNY_ENABLED: "true",
  DATABASE_URL: "postgres://qm@localhost/qm",
  PUBLIC_WEB_URL: "https://qm.example",
  FINNY_SIGNING_SECRET: "finny-signing-secret-0123456789abcdef",
  FINNY_FINDING_POLICY_VERSION: "finance-audit.v1",
  FINNY_MAX_FINDINGS: "12",
  FINNY_MAX_FINDING_CODE_LENGTH: "48",
  FINNY_MAX_FINDING_MESSAGE_LENGTH: "1200",
  FINNY_MAX_REWORKS: "3",
  FINNY_WORKER_GRANT_TTL_MS: "900000",
  FINNY_SPREADSHEET_ENGINE_URL: "https://spreadsheet-engine.example/evaluate",
  FINNY_SPREADSHEET_ENGINE_NAME: "libreoffice-service",
  FINNY_SPREADSHEET_ENGINE_VERSION: "24.2",
  FINNY_SPREADSHEET_ENGINE_TIMEOUT_MS: "30000",
  FINNY_SPREADSHEET_ENGINE_MAX_RESPONSE_BYTES: "1048576",
  FINNY_SPREADSHEET_ENGINE_MAX_ARTIFACT_BYTES: "52428800",
  FINNY_SPREADSHEET_EVALUATOR_ID: "libreoffice-calc",
  FINNY_SPREADSHEET_EVALUATOR_REVISION: "24.2.7-r1",
  FINNY_SPREADSHEET_EVALUATOR_BUILD_DIGEST: "a".repeat(64),
  FINNY_SPREADSHEET_EVALUATOR_CONTRACT_VERSION: "finny.spreadsheet-worker.v2",
  FINNY_SPREADSHEET_EVALUATOR_CONFIGURATION_DIGEST: "b".repeat(64),
  FINNY_MAX_EVIDENCE_BYTES: "4194304",
};

test("Finny integration is disabled by default", () => {
  assert.equal(loadConfig({}).finny, undefined);
  assert.equal(loadConfig({ FINNY_ENABLED: "false" }).finny, undefined);
});

test("enabled Finny integration requires every externally governed setting", () => {
  for (const key of Object.keys(enabled)) {
    if (key === "FINNY_ENABLED" || key === "DATABASE_URL") continue;
    const input = { ...enabled } as Record<string, string>;
    delete input[key];
    assert.throws(() => loadConfig(input), new RegExp(key));
  }
});

test("enabled Finny integration requires PostgreSQL", () => {
  const { DATABASE_URL: _, ...withoutDatabase } = enabled;
  assert.throws(() => loadConfig(withoutDatabase), /DATABASE_URL/);
});

test("enabled Finny integration preserves configured policy and limits", () => {
  assert.deepEqual(loadConfig(enabled).finny, {
    signingSecret: enabled.FINNY_SIGNING_SECRET,
    findingPolicy: {
      id: enabled.FINNY_FINDING_POLICY_VERSION,
      maxFindings: 12,
      maxCodeLength: 48,
      maxMessageLength: 1200,
    },
    maxReworks: 3,
    workerGrantTtlMs: 900000,
    spreadsheetEngine: {
      url: enabled.FINNY_SPREADSHEET_ENGINE_URL,
      name: enabled.FINNY_SPREADSHEET_ENGINE_NAME,
      version: enabled.FINNY_SPREADSHEET_ENGINE_VERSION,
      timeoutMs: 30000,
      maxResponseBytes: 1048576,
      maxArtifactBytes: 52428800,
      evaluator: {
        id: enabled.FINNY_SPREADSHEET_EVALUATOR_ID,
        revision: enabled.FINNY_SPREADSHEET_EVALUATOR_REVISION,
        buildDigest: enabled.FINNY_SPREADSHEET_EVALUATOR_BUILD_DIGEST,
        contractVersion: enabled.FINNY_SPREADSHEET_EVALUATOR_CONTRACT_VERSION,
        configurationDigest: enabled.FINNY_SPREADSHEET_EVALUATOR_CONFIGURATION_DIGEST,
      },
    },
    maxEvidenceBytes: 4194304,
  });
});

test("enabled Finny integration rejects invalid settings instead of applying fallbacks", () => {
  assert.throws(() => loadConfig({ ...enabled, FINNY_SIGNING_SECRET: "short" }), /FINNY_SIGNING_SECRET/);
  assert.throws(
    () => loadConfig({ ...enabled, CORE_SIGNING_SECRET: enabled.FINNY_SIGNING_SECRET }),
    /FINNY_SIGNING_SECRET/,
  );
  assert.throws(() => loadConfig({ ...enabled, FINNY_MAX_REWORKS: "0" }), /FINNY_MAX_REWORKS/);
  assert.throws(() => loadConfig({ ...enabled, FINNY_WORKER_GRANT_TTL_MS: "1.5" }), /FINNY_WORKER_GRANT_TTL_MS/);
  assert.throws(
    () => loadConfig({ ...enabled, FINNY_SPREADSHEET_ENGINE_URL: "http://spreadsheet-engine.example" }),
    /FINNY_SPREADSHEET_ENGINE_URL/,
  );
  assert.throws(
    () => loadConfig({ ...enabled, FINNY_SPREADSHEET_ENGINE_URL: "https://user:pass@spreadsheet-engine.example" }),
    /FINNY_SPREADSHEET_ENGINE_URL/,
  );
  assert.throws(
    () => loadConfig({ ...enabled, FINNY_SPREADSHEET_ENGINE_TIMEOUT_MS: "0" }),
    /FINNY_SPREADSHEET_ENGINE_TIMEOUT_MS/,
  );
  assert.throws(
    () => loadConfig({ ...enabled, FINNY_SPREADSHEET_ENGINE_MAX_RESPONSE_BYTES: "0" }),
    /FINNY_SPREADSHEET_ENGINE_MAX_RESPONSE_BYTES/,
  );
  assert.throws(
    () => loadConfig({ ...enabled, FINNY_SPREADSHEET_ENGINE_MAX_ARTIFACT_BYTES: "0" }),
    /FINNY_SPREADSHEET_ENGINE_MAX_ARTIFACT_BYTES/,
  );
  assert.throws(() => loadConfig({ ...enabled, FINNY_MAX_EVIDENCE_BYTES: "0" }), /FINNY_MAX_EVIDENCE_BYTES/);
});

test("enabled Finny integration rejects invalid evaluator identity metadata", () => {
  assert.throws(
    () => loadConfig({ ...enabled, FINNY_SPREADSHEET_EVALUATOR_BUILD_DIGEST: "latest" }),
    /EVALUATOR_BUILD_DIGEST/,
  );
  assert.throws(
    () => loadConfig({ ...enabled, FINNY_SPREADSHEET_EVALUATOR_CONFIGURATION_DIGEST: "sha256:unknown" }),
    /EVALUATOR_CONFIGURATION_DIGEST/,
  );
  assert.throws(
    () => loadConfig({ ...enabled, FINNY_SPREADSHEET_EVALUATOR_CONTRACT_VERSION: "finny.spreadsheet-worker.v1" }),
    /EVALUATOR_CONTRACT_VERSION/,
  );
});
