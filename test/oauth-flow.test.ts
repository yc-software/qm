import { test } from "node:test";
import assert from "node:assert/strict";
import { createOAuthFlowStore, type OAuthFlowContext } from "../src/connectors/oauth-flow.ts";
import { createMemoryMap, createPostgresMapFactory } from "../src/persistence/durable-map.ts";

const context: Omit<OAuthFlowContext, "createdAt"> = {
  provider: "x",
  principalId: "person@example.comxx",
  redirectUri: "https://prefix-portal.fly.dev/v1/connectors/oauth/x/callback",
  returnTo: "/connectors",
  orgId: "default-org",
  accountType: "company",
  clientId: "x-client-id",
  codeVerifier: "pkce-verifier",
  consentLinkId: "consent-link",
};

test("OAuth flow state is a short opaque handle and preserves the server-side context", async () => {
  const store = createOAuthFlowStore(createMemoryMap<OAuthFlowContext>(), { now: () => 1_000 });
  const { state } = await store.mint(context);
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(state.length < 500);
  assert.deepEqual(await store.redeem(state, 2_000), {
    ok: true,
    context: { ...context, createdAt: 1_000 },
  });
});

test("OAuth flow state expires and is atomically consumed on redemption", async () => {
  const backing = createMemoryMap<OAuthFlowContext>();
  const issuer = createOAuthFlowStore(backing, { ttlMs: 10_000 });
  const callback = createOAuthFlowStore(backing, { ttlMs: 10_000 });
  const { state } = await issuer.mint(context, 1_000);
  const results = await Promise.all([callback.redeem(state, 2_000), issuer.redeem(state, 2_000)]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.reason === "not_found").length, 1);

  const expired = await issuer.mint(context, 1_000);
  assert.deepEqual(await callback.redeem(expired.state, 11_001), { ok: false, reason: "expired" });
  assert.deepEqual(await issuer.redeem(expired.state, 2_000), { ok: false, reason: "not_found" });
});

test("OAuth flow sweep removes abandoned expired context and preserves live flows", async () => {
  const store = createOAuthFlowStore(createMemoryMap<OAuthFlowContext>(), { ttlMs: 10_000 });
  const expired = await store.mint(context, 1_000);
  const live = await store.mint(context, 5_000);
  await store.sweep(11_001);
  assert.deepEqual(await store.redeem(expired.state, 11_001), { ok: false, reason: "not_found" });
  assert.equal((await store.redeem(live.state, 11_001)).ok, true);
});

const databaseUrl = process.env.DATABASE_URL;
const skipPostgres = databaseUrl ? false : "set DATABASE_URL to run the multi-instance OAuth flow test";

test("Postgres-backed OAuth flows redeem once across core instances", { skip: skipPostgres }, async () => {
  const first = createPostgresMapFactory(databaseUrl!);
  const second = createPostgresMapFactory(databaseUrl!);
  const issuer = createOAuthFlowStore(first.map<OAuthFlowContext>("oauth_flows_test"));
  const callbacks = [
    createOAuthFlowStore(first.map<OAuthFlowContext>("oauth_flows_test")),
    createOAuthFlowStore(second.map<OAuthFlowContext>("oauth_flows_test")),
  ];
  try {
    const { state } = await issuer.mint(context);
    const results = await Promise.all(callbacks.map((store) => store.redeem(state)));
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok && result.reason === "not_found").length, 1);
  } finally {
    await first.pool.close();
    await second.pool.close();
  }
});
