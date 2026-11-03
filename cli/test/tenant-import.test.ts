import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTenantImport, tenantImport, type OperatorCall } from "../src/tenant-import.ts";

const env = {
  PI_MODEL: "claude-opus-4-8",
  ADMIN_GRANTS: "a@example.com:org_admin",
  ANTHROPIC_API_KEY: "sk-ant",
  OPENAI_API_KEY: "sk-openai",
  ORG_BRAND_ORG_NAME: "Acme",
  ORG_BRAND_SELF_LABEL: "Bot",
  HARNESS_SECURITY_POSTURE: "strict",
  HARNESS_SHARING_POSTURE: "isolated",
  GOOGLE_OAUTH_CLIENT_ID: "gid",
  GOOGLE_OAUTH_CLIENT_SECRET: "gsecret",
  GOOGLE_WORKSPACE_DOMAIN: "example.com",
  SLACK_OAUTH_CLIENT_ID: "sid",
  LOOPS_USERS: " A@Example.com, bob ",
};

test("old env names map to tenant settings and the admin values they configure", () => {
  const plan = tenantImport(env);
  assert.deepEqual(plan.settings, { PI_MODEL: "claude-opus-4-8", ADMIN_GRANTS: "a@example.com:org_admin" });
  assert.deepEqual(plan.modelKeys, { anthropic: "sk-ant", openai: "sk-openai" });
  assert.deepEqual(plan.branding, { orgName: "Acme", selfLabel: "Bot" });
  assert.deepEqual(plan.postures, { "security-posture": "strict", "sharing-posture": "isolated" });
  assert.deepEqual(plan.oauthClients, [
    { provider: "google", clientId: "gid", clientSecret: "gsecret", hostedDomain: "example.com" },
  ]);
  assert.deepEqual(plan.loopsUsers, ["A@Example.com", "bob"]);
  assert.ok(!plan.names.includes("SLACK_OAUTH_CLIENT_ID"), "an incomplete OAuth client is not imported");
  assert.deepEqual(
    plan.names,
    Object.keys(env)
      .filter((name) => name !== "SLACK_OAUTH_CLIENT_ID")
      .sort(),
  );
});

test("the import writes settings, then each admin value only if the tenant has none", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const existing = new Set(["/v1/admin/scopes/org:default-org/security-posture", "/v1/admin/model-providers/openai"]);
  const call: OperatorCall = async (path, body) => {
    calls.push({ path, body });
    return { status: 200, body: JSON.stringify(existing.has(path) && body.ifUnset ? { unchanged: true } : {}) };
  };
  const warnings: string[] = [];
  const { applied, unsaved } = await applyTenantImport(tenantImport(env), "acme", call, (message) =>
    warnings.push(message),
  );
  assert.deepEqual(unsaved, []);
  assert.deepEqual(applied, [
    "ADMIN_GRANTS",
    "PI_MODEL",
    "branding",
    "sharing-posture",
    "google OAuth client",
    "inbox_loops for personal:a@example.com",
    "inbox_loops for personal:bob",
    "anthropic API key",
  ]);
  assert.ok(calls.every((entry) => entry.body.tenant === "acme"));
  assert.deepEqual(
    calls.map((entry) => entry.path),
    [
      "/v1/install/tenant",
      "/v1/tenant-settings",
      "/v1/admin/scopes/org:default-org/branding",
      "/v1/admin/scopes/org:default-org/security-posture",
      "/v1/admin/scopes/org:default-org/sharing-posture",
      "/v1/admin/scopes/org:default-org/connectors",
      "/v1/admin/scopes/org:default-org/feature-flags",
      "/v1/admin/scopes/org:default-org/feature-flags",
      "/v1/admin/model-providers/anthropic",
      "/v1/admin/model-providers/openai",
    ],
  );
  assert.deepEqual(calls[1]!.body.env, { PI_MODEL: "claude-opus-4-8", ADMIN_GRANTS: "a@example.com:org_admin" });
  assert.deepEqual(calls[2]!.body, { tenant: "acme", orgName: "Acme", selfLabel: "Bot", ifUnset: true });
  assert.deepEqual(calls[6]!.body, {
    tenant: "acme",
    featureName: "inbox_loops",
    scopeId: "personal:a@example.com",
    on: true,
  });
  assert.ok(
    calls
      .filter((entry) => !entry.path.includes("feature-flags") && entry.path.startsWith("/v1/admin/"))
      .every((entry) => entry.body.ifUnset),
  );
  assert.deepEqual(warnings, []);
});

test("a model key core could not check warns with core's answer and the import goes on; other failures stop it", async () => {
  const failing = { path: "/v1/admin/model-providers/anthropic" };
  const call: OperatorCall = async (path) =>
    path === failing.path
      ? { status: 400, body: '{"error":"invalid_api_key","message":"anthropic rejected this API key"}' }
      : { status: 200, body: "{}" };
  const warnings: string[] = [];
  const { applied, unsaved } = await applyTenantImport(
    tenantImport({ ANTHROPIC_API_KEY: "sk", OPENAI_API_KEY: "sk2" }),
    "main",
    call,
    (message) => warnings.push(message),
  );
  assert.deepEqual(warnings, [
    'anthropic API key was not saved (400): {"error":"invalid_api_key","message":"anthropic rejected this API key"}',
  ]);
  assert.deepEqual(applied, ["openai API key"]);
  assert.deepEqual(unsaved, ["ANTHROPIC_API_KEY"]);
  failing.path = "/v1/tenant-settings";
  await assert.rejects(
    applyTenantImport(tenantImport({ PI_MODEL: "m" }), "main", call, () => {}),
    /\/v1\/tenant-settings failed \(400\): \{"error":"invalid_api_key"/,
  );
});
