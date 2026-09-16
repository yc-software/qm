import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { testConfig } from "./support/test-config.ts";
import { descriptor, bundle, client, customKeychain } from "./support/custom-oauth.ts";
import { scopeId } from "../src/types.ts";

const SECRET = "custom-oauth-http-secret".repeat(3);

test("live registration, PKCE consent, fixed organization, refresh, private use, grants and revoke", async () => {
  let refreshes = 0;
  let clock = Date.now();
  const provider = createHttpServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/invoices") {
      assert.equal(req.headers["xero-tenant-id"], "org-a");
      const allowed = ["access", "fresh-1"].includes((req.headers.authorization ?? "").replace("Bearer ", ""));
      res.statusCode = allowed ? 200 : 403;
      return res.end(JSON.stringify({ allowed }));
    }
    assert.equal(req.headers.authorization, `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}`);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    if (form.get("grant_type") === "refresh_token") {
      refreshes++;
      assert.equal(form.get("refresh_token"), refreshes === 1 ? "refresh" : `rotated-${refreshes - 1}`);
      return res.end(
        JSON.stringify({ access_token: `fresh-${refreshes}`, refresh_token: `rotated-${refreshes}`, expires_in: 3600 }),
      );
    }
    assert.equal(form.get("code"), "code-123");
    assert.ok(form.get("code_verifier"));
    res.end(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }));
  });
  provider.listen(0);
  const providerBase = `http://localhost:${(provider.address() as AddressInfo).port}`;
  const transport: typeof fetch = (url, init) => fetch(providerBase + new URL(String(url)).pathname, init);
  const keychain = customKeychain(
    (url, init) => transport(url, init),
    () => clock,
  );
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "oauth-http-")) }));
  const server = createServer(built.app, {
    signingSecret: SECRET,
    deploymentLayer: built.deploymentLayerStore,
    oauthProviders: built.oauthProviders,
    connectorTokens: keychain,
    replayDedupe: built.replayDedupe,
    oauthFlows: built.oauthFlows,
    oauthEnv: { LEDGER_CLIENT_ID: client.id, LEDGER_CLIENT_SECRET: client.secret },
    oauthFetch: (url, init) => transport(url, init),
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const request = async (method: string, path: string, value?: unknown) => {
    const body = value ? JSON.stringify(value) : "";
    const ts = Math.floor(Date.now() / 1000);
    return fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": signRequest(SECRET, ts, `${method}\n${path}\n${body}`),
      },
      ...(body ? { body } : {}),
    });
  };
  try {
    const response = await request("PUT", "/v1/deployment-layer", bundle);
    assert.equal(response.status, 200, await response.text());
    const catalog = (await (await request("GET", "/v1/connectors/catalog")).json()) as {
      catalog: Array<{ provider: string; label: string }>;
    };
    assert.equal(catalog.catalog.find((p) => p.provider === "ledger")?.label, descriptor.label);
    assert.ok(!JSON.stringify(catalog).includes(client.secret));
    const redirect = `${base}/v1/connectors/oauth/ledger/callback`;
    const start = await request(
      "GET",
      `/v1/connectors/oauth/ledger/start?principalId=alice@example.com&redirectUri=${encodeURIComponent(redirect)}`,
    );
    assert.equal(start.status, 200);
    const consent = new URL(((await start.json()) as { authorizeUrl: string }).authorizeUrl);
    assert.equal(consent.searchParams.get("code_challenge_method"), "S256");
    assert.equal(consent.searchParams.get("scope"), descriptor.scopes.join(" "));
    const callback = `${base}/v1/connectors/oauth/ledger/callback?code=code-123&state=${consent.searchParams.get("state")}`;
    const completed = await fetch(callback);
    assert.equal(completed.status, 200, await completed.text());
    assert.equal((await fetch(callback)).status, 400);
    const host = descriptor.hosts[0]!;
    assert.equal(await keychain.connectorAccessToken(host, "alice@example.com"), "access");
    assert.equal(await keychain.connectorAccessToken(host, "bob@example.com"), null);
    for (const method of ["GET", "POST"]) {
      const removed = await request(
        method,
        "/v1/connectors/oauth/ledger/tenants?principalId=alice@example.com",
        method === "POST" ? { principalId: "alice@example.com", tenantId: "org-b" } : undefined,
      );
      assert.equal(removed.status, 404);
    }
    const meta = (await keychain.listConnectorsByOwners(["alice@example.com"])).get("alice@example.com")![0]!;
    const ownScope = scopeId("personal", "alice@example.com");
    await assert.rejects(
      keychain.materializeOwnById("bob@example.com", meta.credentialId, scopeId("personal", "bob@example.com")),
    );
    clock += 55 * 60_000;
    const material = await keychain.materializeOwnById("alice@example.com", meta.credentialId, ownScope);
    assert.equal(material.kind, "env");
    if (material.kind !== "env") throw new Error("expected env");
    assert.deepEqual(material.env, [{ key: "VAULT_TOKEN_API_LEDGER_EXAMPLE", value: "fresh-1" }]);
    const invoices = (token: string) =>
      fetch(`${providerBase}/invoices`, { headers: { authorization: `Bearer ${token}`, "xero-tenant-id": "org-a" } });
    assert.equal((await invoices(material.env[0]!.value)).status, 200);
    assert.equal((await invoices("unauthorized-user-token")).status, 403);
    assert.equal(refreshes, 1);
    assert.ok(!JSON.stringify(material).includes("rotated"));
    assert.ok(!JSON.stringify(material).includes(client.secret));
    const sharedScope = scopeId("channel", "team");
    await assert.rejects(keychain.materializeOwnById("alice@example.com", meta.credentialId, sharedScope));
    const grant = await keychain.createGrant({
      credentialId: meta.credentialId,
      ownerId: "alice@example.com",
      audienceScopeId: sharedScope,
      mode: "standing",
      purpose: "test accounting",
    });
    const shared = await keychain.materialize(grant.id, sharedScope, "bob@example.com");
    if (shared.kind !== "env") throw new Error("expected env");
    assert.deepEqual(shared.env, material.env);
    assert.deepEqual((await keychain.materializeStanding(sharedScope))[0]?.env, material.env);
    assert.equal(
      (await request("POST", "/v1/connectors/oauth/revoke", { provider: "ledger", principalId: "alice@example.com" }))
        .status,
      200,
    );
    assert.equal(await keychain.connectorAccessToken(host, "alice@example.com"), null);
    await assert.rejects(keychain.materialize(grant.id, sharedScope, "bob@example.com"));
    assert.equal((await request("PUT", "/v1/deployment-layer", { contract: 1, tools: [], skills: [] })).status, 200);
    assert.equal(
      (
        await request(
          "GET",
          `/v1/connectors/oauth/ledger/start?principalId=alice@example.com&redirectUri=${encodeURIComponent(redirect)}`,
        )
      ).status,
      404,
    );
  } finally {
    await Promise.all([
      new Promise<void>((r) => server.close(() => r())),
      new Promise<void>((r) => provider.close(() => r())),
    ]);
  }
});
