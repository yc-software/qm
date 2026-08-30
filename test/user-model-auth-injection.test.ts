import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createKeychain } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createUserModelCredentialStore } from "../src/model/user-model-credential-store.ts";
import { readFileSync } from "node:fs";
import { prepareCodexHome } from "../src/harness/codex-harness.ts";
import { codexOAuthAuthFromValue } from "../src/harness/codex-auth-store.ts";
import { resolveIndividualAuthRouting } from "../src/core/individual-auth-routing.ts";
import { resolveModel } from "../src/model/pi-models.ts";
import type { UserModelCredential } from "../src/model/user-model-credential-store.ts";

const apikey = (provider: "anthropic" | "openai", apiKey: string): UserModelCredential => ({
  provider,
  kind: "apikey",
  apiKey,
  updatedAt: 0,
});
const oauth = (provider: "anthropic" | "openai"): UserModelCredential => ({
  provider,
  kind: "oauth",
  oauth: {},
  updatedAt: 0,
});

function fakeIdToken(accountId: string): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "RS256", typ: "JWT" })}.${seg({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.sig`;
}

const KEY_MATERIAL = "test-key-material-that-is-long-enough";

function testStore() {
  const keychain = createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey(KEY_MATERIAL),
  });
  return { keychain, store: createUserModelCredentialStore({ keychain }) };
}

test("user model credential store round-trips api key and oauth per user+provider", async () => {
  const { keychain, store } = testStore();
  await store.setApiKey("u1", "anthropic", "sk-ant-abc");
  const anth = await store.get("u1", "anthropic");
  assert.equal(anth?.kind, "apikey");
  assert.equal(anth?.apiKey, "sk-ant-abc");

  await store.setOAuth("u1", "openai", {
    accessToken: "acc",
    refreshToken: "ref",
    idToken: fakeIdToken("acct_1"),
    accountId: "acct_1",
    expiresAt: Date.now() + 3_600_000,
  });
  const oai = await store.get("u1", "openai");
  assert.equal(oai?.kind, "oauth");

  // The subscription login is a keychain CONNECTOR token: the keychain owns
  // encryption, expiry, and central refresh. Callers only ever get derived
  // material — never the refresh token.
  const derived = await store.derivedOAuth("u1", "openai");
  assert.equal(derived?.accessToken, "acc");
  assert.equal(derived?.idToken, fakeIdToken("acct_1"));
  assert.equal(derived?.accountId, "acct_1");
  assert.ok(!("refreshToken" in (derived ?? {})));
  assert.equal(await store.derivedOAuth("stranger", "openai"), null);

  assert.deepEqual(await store.connections("u1"), [
    { provider: "anthropic", kind: "apikey" },
    { provider: "openai", kind: "oauth" },
  ]);
  assert.deepEqual(await store.connections("stranger"), []);

  // API keys are ordinary user-owned keychain credentials (admin-visible,
  // covered by "remove my credentials").
  const owned = await keychain.listByOwner("u1");
  assert.deepEqual(
    owned.map((c) => c.service),
    ["model-anthropic"],
  );
  assert.ok(owned.every((c) => c.origin === "individual-model-auth"));
  assert.ok(!("secretEnc" in owned[0]!));
  // A stranger cannot read the owner's secret through the store's path.
  assert.equal(await keychain.readOwnSecret("stranger", owned[0]!.id), null);

  // One connection per provider: an API key replaces a subscription login.
  await store.setApiKey("u1", "openai", "sk-oai-xyz");
  assert.equal((await store.get("u1", "openai"))?.kind, "apikey");
  assert.equal(await store.derivedOAuth("u1", "openai"), null);
  // ...and a subscription login replaces an API key.
  await store.setOAuth("u1", "openai", { accessToken: "acc2", idToken: fakeIdToken("acct_1") });
  assert.equal((await store.get("u1", "openai"))?.kind, "oauth");

  await store.delete("u1", "anthropic");
  assert.equal(await store.get("u1", "anthropic"), null);
  await store.delete("u1", "openai");
  assert.equal(await store.get("u1", "openai"), null);
  assert.deepEqual(await store.connections("u1"), []);
});

test("stale subscription tokens refresh once (single-flight) inside the keychain", async () => {
  let refreshCalls = 0;
  const keychain = createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey(KEY_MATERIAL),
    refreshConnector: async (host, token) => {
      refreshCalls += 1;
      assert.equal(host, "auth.openai.com");
      assert.equal(token.refreshToken, "ref-0");
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      return {
        accessToken: "acc-1",
        refreshToken: "ref-1",
        idToken: fakeIdToken("acct_1"),
        expiresAt: Date.now() + 3_600_000,
      };
    },
  });
  const store = createUserModelCredentialStore({ keychain });
  await store.setOAuth("u1", "openai", {
    accessToken: "acc-0",
    refreshToken: "ref-0",
    idToken: fakeIdToken("acct_1"),
    accountId: "acct_1",
    expiresAt: Date.now() - 1_000,
  });
  // Two concurrent turns for the same user: exactly one provider refresh.
  const [a, b] = await Promise.all([store.derivedOAuth("u1", "openai"), store.derivedOAuth("u1", "openai")]);
  assert.equal(refreshCalls, 1);
  assert.equal(a?.accessToken, "acc-1");
  assert.equal(b?.accessToken, "acc-1");
  // The rotated id token and preserved account id both survived the refresh.
  assert.equal(a?.idToken, fakeIdToken("acct_1"));
  assert.equal(a?.accountId, "acct_1");
  // A later read needs no further refresh.
  assert.equal((await store.derivedOAuth("u1", "openai"))?.accessToken, "acc-1");
  assert.equal(refreshCalls, 1);
});

test("routing: anthropic api key -> pi harness with a claude model", () => {
  const r = resolveIndividualAuthRouting(apikey("anthropic", "sk-ant-x"), null, undefined);
  assert.equal(r?.kind, "apikey");
  assert.equal(r?.harness, "pi");
  assert.equal(r?.provider, "anthropic");
  assert.equal((r as { apiKey: string }).apiKey, "sk-ant-x");
});

test("routing: anthropic OAuth login -> claude harness (not pi)", () => {
  const r = resolveIndividualAuthRouting(oauth("anthropic"), null, undefined);
  assert.equal(r?.kind, "oauth");
  assert.equal(r?.harness, "claude");
  assert.equal(r?.model, "claude-opus-5");
});

test("routing: openai OAuth login -> codex harness (not pi)", () => {
  const r = resolveIndividualAuthRouting(null, oauth("openai"), undefined);
  assert.equal(r?.kind, "oauth");
  assert.equal(r?.harness, "codex");
  assert.equal(r?.model, "gpt-5.6-sol");
});

test("routing: requested model provider wins when that provider is connected", () => {
  const r = resolveIndividualAuthRouting(oauth("anthropic"), oauth("openai"), "gpt-5.6-sol");
  assert.equal(r?.harness, "codex");
});

test("routing: openai OAuth + pi org -> pi harness on the Codex subscription provider", () => {
  const r = resolveIndividualAuthRouting(null, oauth("openai"), undefined, "pi");
  assert.equal(r?.kind, "oauth");
  assert.equal(r?.harness, "pi");
  assert.equal(r?.model, "codex/gpt-5.6-sol");
});

test("routing: pi org keeps a requested openai model, namespaced to the subscription provider", () => {
  const r = resolveIndividualAuthRouting(null, oauth("openai"), "gpt-5.6-terra", "pi");
  assert.equal(r?.harness, "pi");
  assert.equal(r?.model, "codex/gpt-5.6-terra");
});

test("routing: a non-pi org still hops to the codex harness", () => {
  const r = resolveIndividualAuthRouting(null, oauth("openai"), undefined, "codex");
  assert.equal(r?.harness, "codex");
});

test("routing: pi org with an anthropic OAuth login still uses the claude harness", () => {
  const r = resolveIndividualAuthRouting(oauth("anthropic"), null, undefined, "pi");
  assert.equal(r?.harness, "claude");
});

test("codex-subscription model ids resolve to pi-ai's openai-codex provider", () => {
  const m = resolveModel("codex/gpt-5.6-sol");
  assert.ok(m, "codex/gpt-5.6-sol must resolve");
  assert.equal(String(m?.provider), "openai-codex");
  assert.equal(String((m as { api?: string })?.api), "openai-codex-responses");
  assert.equal(m?.id, "codex/gpt-5.6-sol");
  // The un-prefixed id keeps resolving to the metered openai provider.
  assert.equal(String(resolveModel("gpt-5.6-sol")?.provider), "openai");
});

test("routing: no credentials -> null (falls through to gate, no deployment key)", () => {
  assert.equal(resolveIndividualAuthRouting(null, null, undefined), null);
});

test("per-user codex child auth is derived material: valid chatgpt auth without the refresh token", () => {
  const userAuth = codexOAuthAuthFromValue({
    auth_mode: "chatgpt",
    tokens: {
      access_token: "acc-token",
      refresh_token: "ref-token",
      id_token: fakeIdToken("acct_9"),
      account_id: "acct_9",
    },
  });
  assert.ok(userAuth, "per-user tokens must satisfy the codex auth validator");
  const jail = mkdtempSync(join(tmpdir(), "codex-inject-"));
  prepareCodexHome({}, jail, userAuth);
  const child = JSON.parse(readFileSync(join(jail, "codex-home", "auth.json"), "utf8")) as {
    auth_mode?: string;
    tokens?: Record<string, unknown>;
  };
  assert.equal(child.auth_mode, "chatgpt");
  assert.equal(child.tokens?.access_token, "acc-token");
  assert.equal(child.tokens?.refresh_token, undefined);
  assert.ok(child.tokens?.id_token);
});
