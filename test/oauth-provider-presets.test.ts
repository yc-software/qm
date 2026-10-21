import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OAUTH_PROVIDER_PRESETS,
  authorizeUrl,
  connectorProvider,
  connectorProviderEntries,
  createSecretClientResolver,
  exchangeCode,
  makeRefresh,
  setStoredOAuthProviders,
  type FetchLike,
} from "../src/connectors/oauth.ts";
import { parseOAuthProviderPreset } from "../src/connectors/custom-provider.ts";
import { createEnvSecretSource } from "../src/credentials/secret-source.ts";
import presets from "../src/connectors/oauth-providers.json" with { type: "json" };

const client = { id: "cid", secret: "csec", clientRef: "test" };

test("every preset builds a working connector", () => {
  for (const preset of OAUTH_PROVIDER_PRESETS) {
    assert.ok(preset.setupSteps?.length, preset.provider);
    const consent = new URL(
      authorizeUrl(preset.provider, { redirectUri: "https://app/cb", state: "s", client: { ...client } }),
    );
    assert.equal(`${consent.origin}${consent.pathname}`, preset.authUrl);
    assert.equal(consent.searchParams.get("client_id"), "cid");
    assert.equal(connectorProvider(preset.provider)?.redirectPath, `${preset.provider}/callback`);
  }
  assert.deepEqual(
    connectorProviderEntries().map(([name]) => name),
    OAUTH_PROVIDER_PRESETS.map((p) => p.provider),
  );
  const hosts = OAUTH_PROVIDER_PRESETS.flatMap((p) => p.hosts);
  assert.equal(new Set(hosts).size, hosts.length, "no two presets claim the same host");
});

test("a preset is parsed with the stored-provider schema plus its built-in fields", () => {
  const [google] = presets;
  assert.deepEqual(parseOAuthProviderPreset(google), OAUTH_PROVIDER_PRESETS[0]);
  assert.throws(() => parseOAuthProviderPreset({ ...google, clientIdEnv: "lower" }), /clientIdEnv/);
  assert.throws(() => parseOAuthProviderPreset({ ...google, tokenAdapter: "custom" }), /tokenAdapter/);
  assert.throws(() => parseOAuthProviderPreset({ ...google, tokenUrl: "http://x.example/t" }), /tokenUrl/);
});

async function wire(provider: string, host: string, codeVerifier?: string): Promise<unknown[]> {
  const calls: unknown[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, ...init });
    return { ok: true, status: 200, json: async () => ({ access_token: "at", refresh_token: "rt", expires_in: 60 }) };
  };
  await exchangeCode(provider, "code1", "https://app/cb", {
    client,
    fetchImpl,
    now: 1,
    ...(codeVerifier ? { codeVerifier } : {}),
  });
  await makeRefresh({ resolveClient: async () => client, fetchImpl, now: () => 1 })(host, {
    accessToken: "o",
    refreshToken: "rt0",
  });
  return calls;
}

test("X and Linear presets send the same token requests as the former hard-coded providers", async () => {
  const xHeaders = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
    authorization: "Basic Y2lkOmNzZWM=",
  };
  assert.deepEqual(await wire("x", "api.x.com", "ver"), [
    {
      url: "https://api.x.com/2/oauth2/token",
      method: "POST",
      headers: xHeaders,
      body: "grant_type=authorization_code&code=code1&redirect_uri=https%3A%2F%2Fapp%2Fcb&client_id=cid&code_verifier=ver",
    },
    {
      url: "https://api.x.com/2/oauth2/token",
      method: "POST",
      headers: xHeaders,
      body: "grant_type=refresh_token&refresh_token=rt0&client_id=cid",
    },
  ]);
  const linearHeaders = { "content-type": "application/x-www-form-urlencoded" };
  assert.deepEqual(await wire("linear", "api.linear.app"), [
    {
      url: "https://api.linear.app/oauth/token",
      method: "POST",
      headers: linearHeaders,
      body: "grant_type=authorization_code&code=code1&redirect_uri=https%3A%2F%2Fapp%2Fcb&client_id=cid&client_secret=csec",
    },
    {
      url: "https://api.linear.app/oauth/token",
      method: "POST",
      headers: linearHeaders,
      body: "grant_type=refresh_token&refresh_token=rt0&client_id=cid&client_secret=csec",
    },
  ]);
});

test("stored providers add to the presets and cannot replace one", async () => {
  const stored = {
    provider: "huddle",
    label: "Huddle",
    authUrl: "https://huddle.example/oauth/authorize",
    tokenUrl: "https://huddle.example/oauth/token",
    hosts: ["api.huddle.example"],
    scopes: [],
    clientAuth: "basic" as const,
  };
  const linear = connectorProvider("linear");
  try {
    setStoredOAuthProviders([stored, { ...stored, provider: "linear", hosts: ["api.linear.app"] }]);
    assert.deepEqual(
      connectorProviderEntries().map(([name]) => name),
      [...OAUTH_PROVIDER_PRESETS.map((p) => p.provider), "huddle"],
    );
    assert.equal(connectorProvider("linear"), linear);
    assert.equal(connectorProvider("huddle")?.tokenUrl, stored.tokenUrl);
    await assert.rejects(createSecretClientResolver(createEnvSecretSource({}))("huddle", {}), /add its OAuth app/);
  } finally {
    setStoredOAuthProviders([]);
  }
  assert.equal(connectorProvider("huddle"), undefined);
});
