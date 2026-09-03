import { test } from "node:test";
import assert from "node:assert/strict";
import { envKey, withOperatorTokenFallback } from "../src/credentials/connector-token.ts";
import { createEnvSecretSource } from "../src/credentials/secret-source.ts";
import {
  createKeychain,
  type KeychainCredential,
  type OAuthRefresh,
  type OAuthToken,
} from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import { oauthRevoke } from "../src/api/routes/connectors.ts";

const KEY = deriveConnectorKey("test-connector-key-aaaaaaaaaaaaaaaa");

function makeKeychain(
  opts: {
    now?: () => number;
    skewMs?: number;
    refresh?: OAuthRefresh;
    creds?: DurableMap<KeychainCredential>;
  } = {},
) {
  const keychain = createKeychain({
    creds: opts.creds ?? createMemoryMap<KeychainCredential>(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: KEY,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.skewMs !== undefined ? { oauthSkewMs: opts.skewMs } : {}),
    ...(opts.refresh ? { refreshConnector: opts.refresh } : {}),
  });
  return keychain;
}

test("operator token fallback can model per-user credentials and host-wide service credentials", async () => {
  const empty = makeKeychain();
  const tokens = withOperatorTokenFallback(
    empty,
    ["gmail.googleapis.com", "tools.example.com"],
    createEnvSecretSource({
      [envKey("gmail.googleapis.com", "U1")]: "alice-oauth",
      [envKey("gmail.googleapis.com", "U2")]: "bob-oauth",
      VAULT_TOKEN_TOOLS_EXAMPLE_COM: "shared-tool-token",
    }),
  );
  assert.equal(await tokens.connectorAccessToken("gmail.googleapis.com", "U1"), "alice-oauth");
  assert.equal(await tokens.connectorAccessToken("gmail.googleapis.com", "U2"), "bob-oauth");
  assert.equal(await tokens.connectorAccessToken("tools.example.com", "U1"), "shared-tool-token");
  assert.equal(await tokens.connectorAccessToken("api.x.com", "U1"), null);
});

test("envKey: the host-wide form keeps its documented shape; per-user keys never collide across principals", () => {
  assert.equal(envKey("gmail.googleapis.com"), "VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM");
  assert.notEqual(envKey("gmail.googleapis.com", "a.b@c.com"), envKey("gmail.googleapis.com", "a-b@c.com"));
  assert.notEqual(envKey("gmail.googleapis.com", "a.b@c.com"), envKey("gmail.googleapis.com", "a_b@c.com"));
  assert.equal(envKey("gmail.googleapis.com", "a.b@c.com"), envKey("gmail.googleapis.com", "a.b@c.com"));
});

test("connector tokens: per-user token + refresh; least-privilege (no shared fallback by default)", async () => {
  let refreshed = 0;
  const tokens = withOperatorTokenFallback(
    makeKeychain({
      now: () => 10_000,
      skewMs: 0,
      refresh: async (_host, t) => {
        refreshed++;
        return { accessToken: "fresh-" + (t.refreshToken ?? ""), refreshToken: t.refreshToken, expiresAt: 1_000_000 };
      },
    }),
    ["search.public.test"],
    createEnvSecretSource({
      [envKey("private.example.test")]: "shared-private-token",
      [envKey("search.public.test")]: "public-key",
    }),
  );

  await tokens.setConnectorToken("private.example.test", "U1", { accessToken: "alice-private", expiresAt: 1_000_000 });
  assert.equal(await tokens.connectorAccessToken("private.example.test", "U1"), "alice-private");

  await tokens.setConnectorToken("gmail.googleapis.com", "U2", {
    accessToken: "stale",
    refreshToken: "rt-2",
    expiresAt: 5_000,
  });
  assert.deepEqual(await tokens.connectorTokenStatus("gmail.googleapis.com", "U2"), {
    connected: true,
    expiresAt: 5_000,
    hasRefreshToken: true,
  });
  assert.equal(await tokens.connectorAccessToken("gmail.googleapis.com", "U2"), "fresh-rt-2");
  assert.equal(refreshed, 1);
  assert.equal(await tokens.connectorAccessToken("gmail.googleapis.com", "U2"), "fresh-rt-2");
  assert.equal(refreshed, 1);
  assert.deepEqual(await tokens.connectorTokenStatus("gmail.googleapis.com", "U2"), {
    connected: true,
    expiresAt: 1_000_000,
    hasRefreshToken: true,
  });

  await tokens.deleteConnectorToken("gmail.googleapis.com", "U2");
  assert.deepEqual(await tokens.connectorTokenStatus("gmail.googleapis.com", "U2"), { connected: false });
  assert.equal(await tokens.connectorAccessToken("gmail.googleapis.com", "U2"), null);

  assert.equal(await tokens.connectorAccessToken("private.example.test", "U9"), null);

  assert.equal(await tokens.connectorAccessToken("search.public.test", "U9"), "public-key");
});

test("disconnect revokes connector grants so reconnect does not resurrect sharing", async () => {
  const keychain = makeKeychain();
  await keychain.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "first" });
  const grant = await keychain.grantConnectorToScope({
    host: "gmail.googleapis.com",
    principalId: "U1",
    audienceScopeId: "channel:C1",
    purpose: "shared inbox",
  });
  assert.ok(grant);

  await keychain.deleteConnectorToken("gmail.googleapis.com", "U1");
  await keychain.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "second" });

  assert.equal((await keychain.getGrant(grant.id))?.status, "revoked");
  assert.deepEqual(await keychain.grantsForScope("channel:C1"), []);
});

test("pending connector updates finalize only while their durable generation is current", async () => {
  const keychain = makeKeychain();
  await keychain.beginConnectorTokenUpdate("auth.example.com", "U1", "attempt-1", "individual");

  assert.deepEqual(await keychain.connectorTokenStatus("auth.example.com", "U1", "individual"), {
    connected: false,
  });
  assert.deepEqual(await keychain.listConnectorsByOwners(["U1"]), new Map());
  assert.equal(
    await keychain.setConnectorTokenIfPending(
      "auth.example.com",
      "U1",
      { accessToken: "wrong" },
      "attempt-0",
      "individual",
    ),
    false,
  );
  assert.equal(
    await keychain.setConnectorTokenIfPending(
      "auth.example.com",
      "U1",
      { accessToken: "first" },
      "attempt-1",
      "individual",
    ),
    true,
  );
  assert.equal(await keychain.connectorAccessToken("auth.example.com", "U1", "individual"), "first");

  await keychain.beginConnectorTokenUpdate("auth.example.com", "U1", "attempt-2", "individual");
  assert.equal(await keychain.connectorAccessToken("auth.example.com", "U1", "individual"), "first");
  await keychain.beginConnectorTokenUpdate("auth.example.com", "U1", "attempt-3", "individual");
  assert.equal(
    await keychain.setConnectorTokenIfPending(
      "auth.example.com",
      "U1",
      { accessToken: "stale" },
      "attempt-2",
      "individual",
    ),
    false,
  );
  await keychain.cancelConnectorTokenUpdate("auth.example.com", "U1", "attempt-3", "individual");
  assert.equal(await keychain.connectorAccessToken("auth.example.com", "U1", "individual"), "first");
});

test("connector deletion wins over an in-flight conditional token update", async () => {
  const keychain = makeKeychain();
  await keychain.beginConnectorTokenUpdate("auth.example.com", "U1", "attempt-1", "individual");

  await keychain.deleteConnectorToken("auth.example.com", "U1", "individual");

  assert.equal(
    await keychain.setConnectorTokenIfPending(
      "auth.example.com",
      "U1",
      { accessToken: "late" },
      "attempt-1",
      "individual",
    ),
    false,
  );
  assert.deepEqual(await keychain.connectorTokenStatus("auth.example.com", "U1", "individual"), {
    connected: false,
  });
});

test("connector token refresh: concurrent callers single-flight; connection metadata survives the rewrite", async () => {
  let nowAt = 10_000;
  let calls = 0;
  let lastCtx: { orgId?: string; accountType?: string; clientRef?: string } | undefined;
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const keychain = makeKeychain({
    now: () => nowAt,
    skewMs: 0,
    refresh: async (_host, _t, ctx) => {
      calls++;
      lastCtx = ctx;
      await gate;
      return { accessToken: "fresh", refreshToken: "rt-rotated", expiresAt: 1_000_000 };
    },
  });
  await keychain.setConnectorToken(
    "gmail.googleapis.com",
    "U1",
    {
      accessToken: "stale",
      refreshToken: "rt",
      expiresAt: 5_000,
      clientRef: "org:default-org:google",
      accountType: "company",
    },
    "company",
  );

  const p1 = keychain.connectorAccessToken("gmail.googleapis.com", "U1", "company");
  const p2 = keychain.connectorAccessToken("gmail.googleapis.com", "U1", "company");
  await new Promise((r) => setImmediate(r));
  release();
  assert.deepEqual(await Promise.all([p1, p2]), ["fresh", "fresh"]);
  assert.equal(calls, 1, "a provider that rotates refresh tokens must not see two racing refreshes");
  assert.deepEqual(lastCtx, { accountType: "company", clientRef: "org:default-org:google" });

  nowAt = 2_000_000;
  let secondToken: OAuthToken | undefined;
  const seen: OAuthToken[] = [];
  const again = makeKeychain({
    now: () => nowAt,
    skewMs: 0,
    refresh: async (_host, t) => {
      seen.push(t);
      secondToken = t;
      return { accessToken: "fresh-2", refreshToken: t.refreshToken, expiresAt: 3_000_000 };
    },
  });
  await again.setConnectorToken(
    "gmail.googleapis.com",
    "U1",
    {
      accessToken: "fresh",
      refreshToken: "rt-rotated",
      expiresAt: 1_000_000,
      clientRef: "org:default-org:google",
      accountType: "company",
    },
    "company",
  );
  assert.equal(await again.connectorAccessToken("gmail.googleapis.com", "U1", "company"), "fresh-2");
  assert.equal(secondToken?.refreshToken, "rt-rotated");
  assert.equal(secondToken?.clientRef, "org:default-org:google");
  assert.equal(seen.length, 1);
});

test("an in-flight refresh survives beginning a connector token update", async () => {
  let refreshStarted!: () => void;
  let finishRefresh!: () => void;
  const started = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  const keychain = makeKeychain({
    now: () => 10_000,
    skewMs: 0,
    refresh: async () => {
      refreshStarted();
      await finish;
      return { accessToken: "fresh", refreshToken: "rotated", expiresAt: 1_000_000 };
    },
  });
  await keychain.setConnectorToken("auth.example.com", "U1", {
    accessToken: "stale",
    refreshToken: "original",
    expiresAt: 5_000,
  });

  const refreshing = keychain.connectorAccessToken("auth.example.com", "U1");
  await started;
  await keychain.beginConnectorTokenUpdate("auth.example.com", "U1", "attempt-1");
  finishRefresh();

  assert.equal(await refreshing, "fresh");
  assert.equal(await keychain.connectorAccessToken("auth.example.com", "U1"), "fresh");
  assert.equal(
    await keychain.setConnectorTokenIfPending("auth.example.com", "U1", { accessToken: "replacement" }, "attempt-1"),
    true,
  );
  assert.equal(await keychain.connectorAccessToken("auth.example.com", "U1"), "replacement");
});

test("an in-flight refresh survives canceling a connector token update and keeps its rotated refresh token", async () => {
  let nowAt = 10_000;
  let calls = 0;
  let refreshStarted!: () => void;
  let finishRefresh!: () => void;
  const started = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  let secondRefreshToken: string | undefined;
  const keychain = makeKeychain({
    now: () => nowAt,
    skewMs: 0,
    refresh: async (_host, token) => {
      calls++;
      if (calls === 1) {
        refreshStarted();
        await finish;
        return { accessToken: "fresh", refreshToken: "rotated", expiresAt: 1_000_000 };
      }
      secondRefreshToken = token.refreshToken;
      return { accessToken: "fresh-again", refreshToken: token.refreshToken, expiresAt: 3_000_000 };
    },
  });
  await keychain.setConnectorToken("auth.example.com", "U1", {
    accessToken: "stale",
    refreshToken: "original",
    expiresAt: 5_000,
  });

  const refreshing = keychain.connectorAccessToken("auth.example.com", "U1");
  await started;
  await keychain.beginConnectorTokenUpdate("auth.example.com", "U1", "attempt-1");
  await keychain.cancelConnectorTokenUpdate("auth.example.com", "U1", "attempt-1");
  finishRefresh();

  assert.equal(await refreshing, "fresh");
  nowAt = 2_000_000;
  assert.equal(await keychain.connectorAccessToken("auth.example.com", "U1"), "fresh-again");
  assert.equal(secondRefreshToken, "rotated");
  assert.equal(calls, 2);
});

test("a successful refresh cannot overwrite a concurrent refresh-token replacement with the same access token", async () => {
  const backing = createMemoryMap<KeychainCredential>();
  let refreshStarted!: () => void;
  let finishRefresh!: () => void;
  const started = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  const keychain = makeKeychain({
    creds: backing,
    now: () => 10_000,
    skewMs: 0,
    refresh: async () => {
      refreshStarted();
      await finish;
      return { accessToken: "old-flight-result", refreshToken: "old-flight-refresh", expiresAt: 1_000_000 };
    },
  });
  await keychain.setConnectorToken("api.github.com", "U1", {
    accessToken: "shared-access",
    refreshToken: "old-refresh",
    expiresAt: 5_000,
  });
  const refreshing = keychain.connectorAccessToken("api.github.com", "U1");
  await started;

  await keychain.setConnectorToken("api.github.com", "U1", {
    accessToken: "shared-access",
    refreshToken: "replacement-refresh",
    expiresAt: 1_000_000,
  });
  finishRefresh();

  assert.equal(await refreshing, "shared-access");
  let observedRefreshToken: string | undefined;
  const probe = makeKeychain({
    creds: backing,
    now: () => 2_000_000,
    skewMs: 0,
    refresh: async (_host, token) => {
      observedRefreshToken = token.refreshToken;
      return { accessToken: "probe", refreshToken: token.refreshToken, expiresAt: 3_000_000 };
    },
  });
  assert.equal(await probe.connectorAccessToken("api.github.com", "U1"), "probe");
  assert.equal(observedRefreshToken, "replacement-refresh");
});

test("derived connector auth does not survive deletion after a successful refresh", async () => {
  const backing = createMemoryMap<KeychainCredential>();
  let deleteBeforeRead = false;
  const creds: DurableMap<KeychainCredential> = {
    ...backing,
    async get(id) {
      if (deleteBeforeRead) {
        deleteBeforeRead = false;
        await backing.delete(id);
      }
      return backing.get(id);
    },
  };
  const keychain = makeKeychain({
    creds,
    now: () => 10_000,
    skewMs: 0,
    refresh: async () => {
      deleteBeforeRead = true;
      return { accessToken: "fresh", refreshToken: "rotated", expiresAt: 1_000_000 };
    },
  });
  await keychain.setConnectorToken("api.github.com", "U1", {
    accessToken: "stale",
    refreshToken: "old-refresh",
    expiresAt: 5_000,
  });

  assert.equal(await keychain.connectorDerivedAuth("api.github.com", "U1"), null);
  assert.deepEqual(await keychain.connectorTokenStatus("api.github.com", "U1"), { connected: false });
});

test("a successful refresh cannot restore a connector token deleted while refresh is in flight", async () => {
  const backing = createMemoryMap<KeychainCredential>();
  let refreshStarted!: () => void;
  let finishRefresh!: () => void;
  const started = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  const keychain = makeKeychain({
    creds: backing,
    now: () => 10_000,
    skewMs: 0,
    refresh: async () => {
      refreshStarted();
      await finish;
      return { accessToken: "fresh", refreshToken: "rotated", expiresAt: 1_000_000 };
    },
  });
  await keychain.setConnectorToken("api.github.com", "U1", {
    accessToken: "stale",
    refreshToken: "old-refresh",
    expiresAt: 5_000,
  });
  const refreshing = keychain.connectorAccessToken("api.github.com", "U1");
  await started;

  await keychain.deleteConnectorToken("api.github.com", "U1");
  finishRefresh();

  assert.equal(await refreshing, null);
  assert.deepEqual(await keychain.connectorTokenStatus("api.github.com", "U1"), { connected: false });
});

test("connector token refresh failures are logged and never poison the stored token", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });

  const creds = createMemoryMap<KeychainCredential>();
  const keychain = makeKeychain({ creds, now: () => 10_000, skewMs: 0, refresh: async () => ({ accessToken: "" }) });
  await keychain.setConnectorToken("api.github.com", "U1", {
    accessToken: "stale",
    refreshToken: "rt",
    expiresAt: 5_000,
  });

  assert.equal(await keychain.connectorAccessToken("api.github.com", "U1"), null);
  assert.deepEqual(
    await keychain.connectorTokenStatus("api.github.com", "U1"),
    {
      connected: true,
      expiresAt: 5_000,
      hasRefreshToken: true,
      needsReconnect: true,
      refreshFailedAt: 10_000,
      refreshError: "refresh returned an empty access token",
    },
    "the empty result was not stored, but the failed refresh is visible",
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /token refresh failed for api\.github\.com/);

  const throwing = makeKeychain({
    creds,
    now: () => 10_000,
    skewMs: 0,
    refresh: async () => {
      throw new Error("revoked by provider");
    },
  });
  assert.equal(await throwing.connectorAccessToken("api.github.com", "U1"), null);
  assert.match(errors[1]!, /revoked by provider/);
  assert.deepEqual(await throwing.connectorTokenStatus("api.github.com", "U1"), {
    connected: true,
    expiresAt: 5_000,
    hasRefreshToken: true,
    needsReconnect: true,
    refreshFailedAt: 10_000,
    refreshError: "revoked by provider",
  });

  const recovered = makeKeychain({
    creds,
    now: () => 20_000,
    skewMs: 0,
    refresh: async (_host, t) => ({ accessToken: "fresh", refreshToken: t.refreshToken, expiresAt: 1_000_000 }),
  });
  assert.equal(await recovered.connectorAccessToken("api.github.com", "U1"), "fresh");
  assert.deepEqual(
    await recovered.connectorTokenStatus("api.github.com", "U1"),
    { connected: true, expiresAt: 1_000_000, hasRefreshToken: true },
    "a successful refresh clears prior failure metadata",
  );
});

test("a refresh failure preserves monotonic ordering across a concurrent connector update", async (t) => {
  t.mock.method(console, "error", () => {});
  const backing = createMemoryMap<KeychainCredential>();
  let refreshStarted!: () => void;
  let finishRefresh!: () => void;
  const started = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  const keychain = makeKeychain({
    creds: backing,
    now: () => 10_000,
    skewMs: 0,
    refresh: async () => {
      refreshStarted();
      await finish;
      throw new Error("temporary provider failure");
    },
  });
  await keychain.setConnectorToken("auth.example.com", "U1", {
    accessToken: "stale",
    refreshToken: "original",
    expiresAt: 5_000,
  });

  const refreshing = keychain.connectorAccessToken("auth.example.com", "U1");
  await started;
  await keychain.beginConnectorTokenUpdate("auth.example.com", "U1", "attempt-1");
  const markerUpdatedAt = (await backing.all())[0]!.updatedAt;
  finishRefresh();

  assert.equal(await refreshing, null);
  const failed = (await backing.all())[0]!;
  assert.ok(failed.updatedAt > markerUpdatedAt);
  assert.equal(failed.refresh?.pendingUpdateId, "attempt-1");
});

test("a failed refresh cannot mark a concurrently replaced connector token as failed", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const backing = createMemoryMap<KeychainCredential>();
  let replaceBeforeWrite = false;
  const replace = async () => {
    if (!replaceBeforeWrite) return;
    replaceBeforeWrite = false;
    await keychain.setConnectorToken("api.github.com", "U1", {
      accessToken: "stale",
      refreshToken: "replacement-refresh",
      expiresAt: 1_000_000,
    });
  };
  const creds: DurableMap<KeychainCredential> = {
    ...backing,
    async merge(id, patch) {
      await replace();
      return backing.merge(id, patch);
    },
    async update(id, fn) {
      await replace();
      return backing.update!(id, fn);
    },
  };
  const keychain = makeKeychain({
    creds,
    now: () => 10_000,
    skewMs: 0,
    refresh: async () => {
      throw new Error("old refresh was revoked");
    },
  });
  await keychain.setConnectorToken("api.github.com", "U1", {
    accessToken: "stale",
    refreshToken: "stale-refresh",
    expiresAt: 5_000,
  });

  replaceBeforeWrite = true;
  assert.equal(await keychain.connectorAccessToken("api.github.com", "U1"), null);
  assert.equal(await keychain.connectorAccessToken("api.github.com", "U1"), "stale");
  assert.deepEqual(await keychain.connectorTokenStatus("api.github.com", "U1"), {
    connected: true,
    expiresAt: 1_000_000,
    hasRefreshToken: true,
  });
  let observedRefreshToken: string | undefined;
  const probe = makeKeychain({
    creds: backing,
    now: () => 2_000_000,
    skewMs: 0,
    refresh: async (_host, token) => {
      observedRefreshToken = token.refreshToken;
      return { accessToken: "probe", refreshToken: token.refreshToken, expiresAt: 3_000_000 };
    },
  });
  assert.equal(await probe.connectorAccessToken("api.github.com", "U1"), "probe");
  assert.equal(observedRefreshToken, "replacement-refresh");
});

test("connector refresh requires an atomic credential update capability", () => {
  const { update: _, ...creds } = createMemoryMap<KeychainCredential>();
  assert.throws(
    () => makeKeychain({ creds, refresh: async () => ({ accessToken: "fresh" }) }),
    /connector token refresh requires atomic credential updates/,
  );
});

test("connector tokens: expired non-refreshable connector tokens need reconnect", async () => {
  const keychain = makeKeychain({ now: () => 10_000, skewMs: 0 });
  await keychain.setConnectorToken("slack.com", "U1", { accessToken: "stale-slack", expiresAt: 5_000 });

  assert.equal(await keychain.connectorAccessToken("slack.com", "U1"), null);
  assert.deepEqual(await keychain.connectorTokenStatus("slack.com", "U1"), {
    connected: true,
    expiresAt: 5_000,
    needsReconnect: true,
  });
});

test("connector token keys are Postgres-safe (no NUL byte) — round-trip through a NUL-rejecting backing", async () => {
  const store = new Map<string, KeychainCredential>();
  const seenKeys: string[] = [];
  const rejectNul = (k: string): void => {
    if (k.includes("\u0000")) throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
    seenKeys.push(k);
  };
  const creds: DurableMap<KeychainCredential> = {
    async all() {
      return [...store.values()];
    },
    async entries() {
      return [...store.entries()];
    },
    async get(k: string) {
      rejectNul(k);
      return store.get(k) ?? null;
    },
    async put(k: string, v: KeychainCredential) {
      rejectNul(k);
      store.set(k, v);
    },
    async putIfAbsent(k: string, v: KeychainCredential) {
      rejectNul(k);
      const e = store.get(k);
      if (e) return e;
      store.set(k, v);
      return v;
    },
    async merge(k: string, patch: Partial<KeychainCredential>) {
      rejectNul(k);
      const v = store.get(k);
      if (!v) return null;
      const merged = { ...v, ...patch };
      store.set(k, merged);
      return merged;
    },
    async delete(k: string) {
      rejectNul(k);
      store.delete(k);
    },
    async take(k: string) {
      rejectNul(k);
      const v = store.get(k) ?? null;
      store.delete(k);
      return v;
    },
  };
  const keychain = makeKeychain({ creds });

  await keychain.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "tok" }, "personal");
  assert.equal(await keychain.connectorAccessToken("gmail.googleapis.com", "U1", "personal"), "tok");
  assert.equal((await keychain.connectorTokenStatus("gmail.googleapis.com", "U1", "personal")).connected, true);
  await keychain.setConnectorToken("slack.com", "U2", { accessToken: "tok2" });
  assert.equal(await keychain.connectorAccessToken("slack.com", "U2"), "tok2");

  assert.ok(seenKeys.length > 0);
  assert.ok(
    seenKeys.every((k) => !k.includes("\u0000")),
    "connector record keys must contain no NUL byte (Postgres-incompatible)",
  );
});

test("connector token account-type sub-key: a principal holds personal AND company tokens for one host", async () => {
  const keychain = makeKeychain({ now: () => 10_000, skewMs: 0 });

  await keychain.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "legacy-default" });
  await keychain.setConnectorToken(
    "gmail.googleapis.com",
    "U1",
    { accessToken: "personal-tok", accountType: "personal" },
    "personal",
  );
  await keychain.setConnectorToken(
    "gmail.googleapis.com",
    "U1",
    { accessToken: "company-tok", accountType: "company" },
    "company",
  );

  assert.equal(await keychain.connectorAccessToken("gmail.googleapis.com", "U1"), "legacy-default");
  assert.equal(await keychain.connectorAccessToken("gmail.googleapis.com", "U1", "personal"), "personal-tok");
  assert.equal(await keychain.connectorAccessToken("gmail.googleapis.com", "U1", "company"), "company-tok");

  assert.equal((await keychain.connectorTokenStatus("gmail.googleapis.com", "U1", "company")).accountType, "company");

  await keychain.deleteConnectorToken("gmail.googleapis.com", "U1", "personal");
  assert.equal(await keychain.connectorAccessToken("gmail.googleapis.com", "U1", "personal"), null);
  assert.equal(await keychain.connectorAccessToken("gmail.googleapis.com", "U1", "company"), "company-tok");
  assert.equal(await keychain.connectorAccessToken("gmail.googleapis.com", "U1"), "legacy-default");
});

test("disconnect revokes connector grants so reconnect cannot restore old access", async () => {
  const keychain = makeKeychain({ now: () => 10_000, skewMs: 0 });
  await keychain.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "first" });
  const grant = await keychain.grantConnectorToScope({
    host: "gmail.googleapis.com",
    principalId: "U1",
    audienceScopeId: "channel:C1",
    purpose: "read mail here",
  });
  assert.ok(grant);

  await keychain.deleteConnectorToken("gmail.googleapis.com", "U1");
  await keychain.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "second" });

  assert.equal((await keychain.getGrant(grant.id))?.status, "revoked");
  assert.deepEqual(await keychain.grantsForScope("channel:C1"), []);
});

test("connector tokens are hidden from keychain listings and own-credential materialization", async () => {
  const creds = createMemoryMap<KeychainCredential>();
  const keychain = makeKeychain({ creds, now: () => 10_000, skewMs: 0 });
  await keychain.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "tok" });
  await keychain.save({ ownerId: "U1", service: "github", secret: "ghp_x", envKey: "GITHUB_TOKEN" });

  const listed = await keychain.listByOwner("U1");
  assert.deepEqual(
    listed.map((c) => c.service),
    ["github"],
  );
  const own = await keychain.materializeOwn("U1");
  assert.deepEqual(
    own.map((m) => m.env[0]!.key),
    ["GITHUB_TOKEN"],
  );

  const connector = (await creds.all()).find((c) => c.managed === "connector")!;
  assert.equal(await keychain.remove("U1", connector.id), false);
  assert.equal(await keychain.connectorAccessToken("gmail.googleapis.com", "U1"), "tok");
});

test("oauthRevoke: a capability token disconnects its own connector, but not a non-member's", async () => {
  const deleted: Array<{ host: string; principalId: string }> = [];
  const deps = {
    connectorTokens: {
      deleteConnectorToken: async (host: string, principalId: string) => {
        deleted.push({ host, principalId });
      },
    },
  } as unknown as Parameters<typeof oauthRevoke>[0]["deps"];
  const call = (capability: unknown, body: unknown) => {
    const out: { status?: number; body?: any } = {};
    const res = {
      writeHead(s: number) {
        out.status = s;
      },
      end(d?: string) {
        out.body = d ? JSON.parse(d) : undefined;
      },
    };
    return oauthRevoke({ res, deps, body, capability } as unknown as Parameters<typeof oauthRevoke>[0]).then(() => out);
  };
  const cap = (actorId: string, members: string[] = []) => ({
    actorId,
    scopeId: `personal:${actorId}`,
    keychainMembers: members.map((id) => ({ id })),
    exp: 9_999_999_999,
  });

  deleted.length = 0;
  const self = await call(cap("U1"), { provider: "google" });
  assert.equal(self.status, 200);
  assert.equal(self.body.principalId, "U1");
  assert.ok(deleted.length > 0 && deleted.every((d) => d.principalId === "U1"));

  const member = await call(cap("U1", ["U2"]), { provider: "google", principalId: "U2" });
  assert.equal(member.status, 200);
  assert.equal(member.body.principalId, "U2");

  deleted.length = 0;
  const stranger = await call(cap("U1"), { provider: "google", principalId: "U9" });
  assert.equal(stranger.status, 400);
  assert.equal(deleted.length, 0);
});

test("operator token fallback: an empty per-user secret falls through to the host-wide token", async () => {
  const tokens = withOperatorTokenFallback(makeKeychain(), ["gmail.googleapis.com"], {
    get: async (name) => {
      if (name === envKey("gmail.googleapis.com", "U1")) return "";
      return name === envKey("gmail.googleapis.com") ? "host-wide" : undefined;
    },
  });
  assert.equal(await tokens.connectorAccessToken("gmail.googleapis.com", "U1"), "host-wide");
});
