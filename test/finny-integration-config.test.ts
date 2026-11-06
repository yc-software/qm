import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

const enabled = {
  FINNY_ENABLED: "true",
  DATABASE_URL: "postgres://qm@localhost/qm",
  FINNY_SIGNING_SECRET: "finny-signing-secret-0123456789abcdef",
  FINNY_FINDING_POLICY_VERSION: "finance-audit.v1",
  FINNY_MAX_FINDINGS: "12",
  FINNY_MAX_FINDING_CODE_LENGTH: "48",
  FINNY_MAX_FINDING_MESSAGE_LENGTH: "1200",
  FINNY_MAX_REWORKS: "3",
  FINNY_WORKER_GRANT_TTL_MS: "900000",
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
});
