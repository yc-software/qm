import { test } from "node:test";
import assert from "node:assert/strict";
import { CORE_SECRET_SPECS } from "../src/deployment/secret-schema.ts";
import { FIRST_PARTY_SECRET_SPECS } from "../cli/src/secrets.ts";

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
  const runtimeConditionEnv = [
    "SANDBOX_BACKEND",
    "DEPLOY_PROVIDER",
    "AWS_DEPLOY_APPS_DOMAIN",
    "DEPLOY_APPS_DOMAIN",
    "GOOGLE_OAUTH_CLIENT_ID",
    "DROPBOX_OAUTH_CLIENT_ID",
    "LINEAR_OAUTH_CLIENT_ID",
  ];
  const cliConditionEnv = new Set<string>();
  interface CliCondition {
    kind?: string;
    name?: string;
    names?: string[];
    conditions?: CliCondition[];
  }
  const collect = (when: CliCondition): void => {
    if (when.kind === "sandbox-backend") cliConditionEnv.add("SANDBOX_BACKEND");
    if (when.name) cliConditionEnv.add(when.name);
    for (const name of when.names ?? []) cliConditionEnv.add(name);
    for (const nested of when.conditions ?? []) collect(nested);
  };
  for (const spec of FIRST_PARTY_SECRET_SPECS) {
    if (typeof spec.required === "boolean") continue;
    collect(spec.required.when as CliCondition);
  }
  const missing = runtimeConditionEnv.filter((name) => !cliConditionEnv.has(name));
  assert.deepEqual(
    missing,
    [],
    `runtime schema conditions use env vars the CLI schema never conditions on: ${missing.join(", ")}`,
  );
});
