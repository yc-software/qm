import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createKeychain, KeychainError, type OAuthRefresh } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createMcpServerStore } from "../src/mcp/mcp-server-store.ts";
import { createMcpToolService } from "../src/mcp/mcp-tool-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const GOOGLE_HOSTS = [
  "gmail.googleapis.com",
  "www.googleapis.com",
  "sheets.googleapis.com",
  "docs.googleapis.com",
  "slides.googleapis.com",
];

function keychain(
  blockedConnectorMaterializationHosts: readonly string[] = GOOGLE_HOSTS,
  refreshConnector?: OAuthRefresh,
) {
  return createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("google-confinement-test"),
    blockedConnectorMaterializationHosts,
    ...(refreshConnector ? { refreshConnector } : {}),
  });
}

const forbidden = (error: unknown) => error instanceof KeychainError && error.status === 403;

for (const host of GOOGLE_HOSTS) {
  for (const route of ["own", "raw", "derived"] as const) {
    test(`guarded ${host} refuses ${route} credential exports`, async () => {
      const k = keychain();
      await k.setConnectorToken(host, "U1", { accessToken: "google-secret", idToken: "google-id" }, "personal");
      const [credential] = (await k.listConnectorsByOwners(["U1"])).get("U1")!;
      assert.ok(credential);
      const exports = {
        own: () => k.materializeOwnById("U1", credential.credentialId, "personal:U1"),
        raw: () => k.readOwnSecret("U1", credential.credentialId),
        derived: () => k.connectorDerivedAuth(host.toUpperCase(), "U1", "personal"),
      };
      const result = exports[route]();
      await assert.rejects(result, forbidden);
      assert.deepEqual(await k.materializeOwn("U1"), []);
      assert.deepEqual(await k.materializeOwnFiles("U1"), []);
      assert.equal(await k.connectorAccessToken(host, "U1", "personal"), "google-secret");
    });
  }

  test(`guarded ${host} refuses grants without consuming a one-time grant`, async () => {
    const k = keychain();
    await k.setConnectorToken(host, "U1", { accessToken: "google-secret" });
    const [credential] = (await k.listConnectorsByOwners(["U1"])).get("U1")!;
    for (const mode of ["once", "standing"] as const) {
      const grant = await k.createGrant({
        credentialId: credential!.credentialId,
        ownerId: "U1",
        audienceScopeId: "channel:C1",
        mode,
        purpose: "Read document",
      });
      await assert.rejects(k.materialize(grant.id, "channel:C1", "U2"), forbidden);
      assert.equal((await k.getGrant(grant.id))?.status, "active");
    }
    assert.deepEqual(await k.materializeStanding("channel:C1"), []);
  });
}

test("guarded standing injection skips Google and preserves other credential grants", async () => {
  const k = keychain();
  for (const host of ["www.googleapis.com", "api.github.com"]) {
    await k.setConnectorToken(host, "U1", { accessToken: `${host}-token` });
    await k.grantConnectorToScope({ host, principalId: "U1", audienceScopeId: "channel:C1", purpose: "Read" });
  }
  const injected = await k.materializeStanding("channel:C1");
  assert.equal(injected.length, 1);
  assert.equal(injected[0]?.service, "api.github.com");
  assert.equal(injected[0]?.env[0]?.value, "api.github.com-token");
});

test("guarded server access refreshes Google while metadata remains available", async () => {
  const k = keychain(GOOGLE_HOSTS, async (host, token) => {
    assert.equal(host, "www.googleapis.com");
    assert.equal(token.refreshToken, "google-refresh");
    return { accessToken: "google-fresh", refreshToken: "rotated-refresh", expiresAt: Date.now() + 3_600_000 };
  });
  await k.setConnectorToken("www.googleapis.com", "U1", {
    accessToken: "google-old",
    refreshToken: "google-refresh",
    expiresAt: 1,
  });
  assert.equal(await k.connectorAccessToken("www.googleapis.com", "U1"), "google-fresh");
  assert.equal((await k.connectorTokenStatus("www.googleapis.com", "U1")).connected, true);
  const [credential] = (await k.listConnectorsByOwners(["U1"])).get("U1")!;
  assert.ok(await k.getCredential(credential!.credentialId));
  await assert.rejects(k.connectorDerivedAuth("www.googleapis.com", "U1"), forbidden);
});

test("unguarded Google credential use remains compatible", async () => {
  const k = keychain([]);
  await k.setConnectorToken("www.googleapis.com", "U1", { accessToken: "google-secret", idToken: "google-id" });
  const [credential] = (await k.listConnectorsByOwners(["U1"])).get("U1")!;
  const materialized = await k.materializeOwnById("U1", credential!.credentialId, "personal:U1");
  assert.equal(materialized.kind, "env");
  assert.equal(await k.readOwnSecret("U1", credential!.credentialId), "google-secret");
  assert.deepEqual(await k.connectorDerivedAuth("www.googleapis.com", "U1"), {
    accessToken: "google-secret",
    idToken: "google-id",
  });
});

for (const blocked of [true, false]) {
  test(`MCP Google user token requests are ${blocked ? "blocked" : "compatible"} in guarded=${blocked}`, async (t) => {
    const users = keychain();
    await users.setConnectorToken("www.googleapis.com", "U1", { accessToken: "google-secret" });
    const servers = createMcpServerStore(createMemoryMap());
    await servers.put({
      id: "external",
      name: "External MCP",
      url: "https://external.example/mcp",
      auth: "none",
      credentialScope: "per-user",
      credentialHost: "WWW.GOOGLEAPIS.COM",
      readOnly: false,
      enabled: true,
      updatedAt: 0,
      updatedBy: "admin",
    });
    const exportedHeaders: string[] = [];
    const service = createMcpToolService({
      servers,
      userTokens: users,
      blockedUserTokenHosts: blocked ? GOOGLE_HOSTS : [],
      fetchImpl: async (_url, init) => {
        if (init.headers.authorization) exportedHeaders.push(init.headers.authorization);
        const rpc = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: async () =>
            JSON.stringify({
              result:
                rpc.method === "tools/list"
                  ? { tools: [{ name: "action", inputSchema: { type: "object" } }] }
                  : { content: [{ type: "text", text: "result" }] },
            }),
        };
      },
    });
    t.after(() => service.close());
    await service.refresh();
    if (blocked) {
      await assert.rejects(service.call("external_action", {}, "U1"), /trusted service/);
      assert.deepEqual(exportedHeaders, []);
    } else {
      assert.equal(await service.call("external_action", {}, "U1"), "result");
      assert.ok(exportedHeaders.includes("Bearer google-secret"));
    }
  });
}

for (const [value, expected] of [
  [undefined, false],
  ["1", true],
  ["true", true],
  ["0", false],
] as const) {
  test(`guarded Google configuration maps ${String(value)} to ${expected}`, () => {
    assert.equal(loadConfig({ GOOGLE_WORKSPACE_GUARDED: value }).googleWorkspaceGuarded, expected);
  });
}

test("guarded Google configuration rejects unrecognized values instead of silently disabling confinement", () => {
  assert.throws(() => loadConfig({ GOOGLE_WORKSPACE_GUARDED: "enabled" }), /GOOGLE_WORKSPACE_GUARDED/);
});
