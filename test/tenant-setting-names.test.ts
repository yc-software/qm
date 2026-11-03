import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { TENANT_SETTING_KEYS } from "../src/tenants/settings.ts";
import { PROVIDERS } from "../src/connectors/oauth.ts";
import { MODEL_PROVIDERS } from "../src/model/pi-models.ts";
import { orgScope } from "../src/config.ts";
import { ORG_SCOPE } from "../cli/src/tenant-import.ts";
import {
  MODEL_KEY_ENV,
  OAUTH_CLIENT_ENV,
  TENANT_ENV_NAMES,
  TENANT_SETTING_KEYS as CLI_TENANT_SETTING_KEYS,
} from "../cli/src/tenant-setting-names.ts";

test("the CLI sends exactly core's tenant setting keys", () => {
  assert.deepEqual([...CLI_TENANT_SETTING_KEYS], [...TENANT_SETTING_KEYS]);
});

test("the CLI translates every OAuth client and model provider core knows", () => {
  const oauth = Object.entries(PROVIDERS)
    .filter(([, provider]) => provider.clientIdEnv)
    .map(([name, provider]) => [name, [provider.clientIdEnv, provider.clientSecretEnv]]);
  assert.deepEqual(Object.entries(OAUTH_CLIENT_ENV), oauth);
  assert.deepEqual(Object.keys(MODEL_KEY_ENV).sort(), [...MODEL_PROVIDERS].sort());
});

test("Helm refuses exactly the CLI's tenant names in service env", () => {
  const template = readFileSync(new URL("../deploy/helm/templates/tenant-settings.yaml", import.meta.url), "utf8");
  const listed = [...template.split("\n")[0]!.matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]!);
  assert.equal(new Set(listed).size, listed.length);
  assert.deepEqual([...listed].sort(), [...TENANT_ENV_NAMES].sort());
});

test("the CLI writes admin values to the org scope core uses when ORG_ID is unset", () => {
  const prior = process.env.ORG_ID;
  delete process.env.ORG_ID;
  try {
    assert.equal(ORG_SCOPE, orgScope());
  } finally {
    if (prior !== undefined) process.env.ORG_ID = prior;
  }
});
