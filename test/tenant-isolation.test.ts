import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tenantFor, withTenant } from "../src/tenant.ts";
import { modelOverlayVersion, resolveModel, setModelOverlays, validateModelOverlay } from "../src/model/pi-models.ts";
import { isCustomModelId, setCustomProviders } from "../src/model/custom-providers.ts";
import { setMentionIndex, toSlackMrkdwn } from "../src/slack/mrkdwn.ts";
import { oauthProvider, setPublicOAuthClients } from "../src/connectors/oauth.ts";
import { mintPortalIdentity, verifyPortalIdentity } from "../src/auth/portal-identity.ts";
import { CAPABILITY_TTL_MS, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { scopeId } from "../src/types.ts";

const alpha = tenantFor("tenant-alpha");
const beta = tenantFor("tenant-beta");

test("an admin-registered model overlay is visible only to the tenant that registered it", () => {
  const overlay = validateModelOverlay({
    id: "alpha-only-model",
    name: "Alpha only",
    provider: "openai",
    template: "gpt-5.5",
    contextWindow: 400_000,
    maxTokens: 20_000,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  });
  withTenant(alpha, () => setModelOverlays([overlay]));
  assert.ok(withTenant(alpha, () => resolveModel("alpha-only-model")));
  assert.equal(
    withTenant(beta, () => resolveModel("alpha-only-model")),
    undefined,
  );
  assert.notEqual(
    withTenant(alpha, () => modelOverlayVersion()),
    withTenant(beta, () => modelOverlayVersion()),
  );
});

test("custom providers, Slack mention names and MCP sign-in clients do not cross tenants", () => {
  withTenant(alpha, () => {
    setCustomProviders([
      { id: "alpha", name: "Alpha", protocol: "openai", baseUrl: "https://alpha.example/v1", models: [{ id: "m" }] },
    ]);
    setMentionIndex(new Map([["ankit", "U111"]]));
    setPublicOAuthClients([
      {
        name: "orders",
        host: "api.orders.example",
        authUrl: "https://id.orders.example/authorize",
        tokenUrl: "https://id.orders.example/token",
        scopes: ["orders:write"],
        clientId: "public-client",
        label: "Orders",
      },
    ]);
  });
  assert.equal(
    withTenant(alpha, () => isCustomModelId("custom/alpha/m")),
    true,
  );
  assert.equal(
    withTenant(beta, () => isCustomModelId("custom/alpha/m")),
    false,
  );
  assert.equal(
    withTenant(alpha, () => toSlackMrkdwn("thanks @ankit!")),
    "thanks <@U111>!",
  );
  assert.equal(
    withTenant(beta, () => toSlackMrkdwn("thanks @ankit!")),
    "thanks @ankit!",
  );
  assert.ok(withTenant(alpha, () => oauthProvider("orders")));
  assert.equal(
    withTenant(beta, () => oauthProvider("orders")),
    undefined,
  );
});

test("a portal identity naming another tenant is reported and still accepted while every process serves one tenant", async (t) => {
  const reports = t.mock.method(console, "error", () => {});
  const secret = "portal-identity-tenant-secret";
  const now = 1_000_000;
  const forAlpha = await mintPortalIdentity({ p: "alice@example.com", t: "tenant-alpha", exp: now + 60_000 }, secret);
  assert.equal((await withTenant(alpha, () => verifyPortalIdentity(forAlpha, secret, now)))?.p, "alice@example.com");
  assert.equal(reports.mock.callCount(), 0);
  assert.equal((await withTenant(beta, () => verifyPortalIdentity(forAlpha, secret, now)))?.p, "alice@example.com");
  assert.equal(reports.mock.callCount(), 1);
  assert.match(
    String(reports.mock.calls[0]!.arguments[0]),
    /credential issued for another tenant.*portal identity names tenant tenant-alpha; this process serves tenant-beta/,
  );
});

test("the API reports a capability token minted for another tenant", async (t) => {
  const reports = t.mock.method(console, "error", () => {});
  const secret = "tenant-capability-secret".repeat(2);
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "tenant-cap-")), signingSecret: secret }));
  const server = createServer(built.app, { admin: built.admin, memory: built.memory, signingSecret: secret });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const mint = () =>
    mintCapabilityToken(
      { actorId: "U1", scopeId: scopeId("personal", "U1"), exp: Date.now() + CAPABILITY_TTL_MS },
      secret,
    );
  const status = async (cap: string) =>
    (await fetch(`${base}/v1/apis`, { headers: { "x-agent-capability": cap } })).status;
  try {
    assert.equal(await status(await mint()), 200);
    assert.equal(reports.mock.calls.filter((call) => /another tenant/.test(String(call.arguments[0]))).length, 0);
    assert.equal(await status(await withTenant(alpha, mint)), 200);
    assert.equal(
      reports.mock.calls.filter((call) => /capability token names tenant tenant-alpha/.test(String(call.arguments[0])))
        .length,
      1,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
