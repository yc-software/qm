import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { serverDeps, type BuiltApp } from "../src/wiring.ts";

const built = { sandbox: { profile: { backend: "local" } } } as BuiltApp;

test("app gateway wiring uses the generic domain even when AWS's provider-specific domain differs", () => {
  const config = loadConfig({
    DEPLOY_APPS_DOMAIN: "apps.example.test",
    AWS_DEPLOY_APPS_DOMAIN: "provider.example.test",
    AWS_DEPLOY_GATE_SECRET: "0123456789abcdef0123456789abcdef",
    ORG_ID: "acme",
  });
  const deps = serverDeps(config, built);
  assert.equal(deps.deployAppsDomain, "apps.example.test");
  assert.equal(deps.deployGateSecret, "0123456789abcdef0123456789abcdef");
  assert.equal(deps.deployAppsOrgId, "acme");
});

test("a Porter runtime domain is not silently promoted to the trusted app gateway domain", () => {
  const config = loadConfig({
    DEPLOY_PROVIDER: "porter",
    PORTER_DEPLOY_API_TOKEN: "synthetic",
    PORTER_DEPLOY_PROJECT_ID: "7",
    PORTER_DEPLOY_CLUSTER_ID: "9",
    PORTER_DEPLOY_APPS_DOMAIN: "runtime.example.test",
  });
  assert.equal(config.porterDeploy.appsDomain, "runtime.example.test");
  assert.equal(serverDeps(config, built).deployAppsDomain, undefined);
});
