import { test } from "node:test";
import assert from "node:assert/strict";
import { CORE_SECRET_SPECS } from "../src/deployment/secret-schema.ts";
import { FIRST_PARTY_SECRET_SPECS } from "../cli/src/secrets.ts";

// The runtime schema (src/deployment/secret-schema.ts, validated on core boot) and the CLI
// provisioning schema (cli/src/secrets.ts, driving `qm secrets`) are maintained separately by
// design — the CLI never imports core. This test keeps them from drifting apart silently:
// every secret the runtime can demand must be one the CLI knows how to provision.

// The env name a CLI spec ultimately delivers to the core process.
const cliCoreEnvNames = new Set(
  FIRST_PARTY_SECRET_SPECS.filter((spec) => spec.service === "core").map((spec) => spec.envName ?? spec.name),
);

test("every runtime-validated core secret is provisionable through the CLI schema", () => {
  const missing = CORE_SECRET_SPECS.map((spec) => spec.name).filter((name) => !cliCoreEnvNames.has(name));
  assert.deepEqual(
    missing,
    [],
    `runtime secret-schema names with no matching CLI secret spec (name or envName, service "core"): ${missing.join(
      ", ",
    )} — add a spec to cli/src/secrets.ts or drop it from src/deployment/secret-schema.ts`,
  );
});

test("runtime schema conditions reference env vars the CLI schema also conditions on", () => {
  // Env vars the runtime's requiredWhen rules read. Each must also drive a CLI spec condition,
  // so `qm secrets` and core boot validation agree about when a secret becomes required.
  const runtimeConditionEnv = [
    "SANDBOX_BACKEND",
    "DEPLOY_PROVIDER",
    "AWS_DEPLOY_APPS_DOMAIN",
    "GOOGLE_OAUTH_CLIENT_ID",
    "DROPBOX_OAUTH_CLIENT_ID",
    "LINEAR_OAUTH_CLIENT_ID",
  ];
  const cliConditionEnv = new Set<string>();
  for (const spec of FIRST_PARTY_SECRET_SPECS) {
    if (typeof spec.required === "boolean") continue;
    const when = spec.required.when as { name?: string; names?: string[] };
    if (when.name) cliConditionEnv.add(when.name);
    for (const name of when.names ?? []) cliConditionEnv.add(name);
  }
  const missing = runtimeConditionEnv.filter((name) => !cliConditionEnv.has(name));
  assert.deepEqual(
    missing,
    [],
    `runtime schema conditions use env vars the CLI schema never conditions on: ${missing.join(", ")}`,
  );
});
