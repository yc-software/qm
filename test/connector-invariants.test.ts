import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { PROVIDERS, sealOAuthState } from "../src/connectors/oauth.ts";
import { credentialHandle } from "../src/credentials/keychain.ts";
import { envKey, withOperatorTokenFallback } from "../src/credentials/connector-token.ts";
import type { ConnectorTokenStore } from "../src/credentials/keychain.ts";
import type { TurnRequest } from "../src/types.ts";
import { fakeSprites } from "./support/auto-fake-sprites.ts";
import { testConfig } from "./support/test-config.ts";

const CATALOG_HOSTS = Object.values(PROVIDERS).flatMap((p) => p.hosts);

test("C3 — no catalog host appears in serviceHosts / egressServiceHosts (least privilege)", () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "c3-")) }));
  return Promise.all(CATALOG_HOSTS.map((h) => built.connectorTokens.connectorAccessToken(h, "nobody"))).then(
    (tokens) => {
      assert.ok(
        tokens.every((t) => t === null),
        "a catalog host must have no shared/service token by default",
      );
    },
  );
});

test("C3 — a catalog host wrongly listed as a service host is detectable via the real token-store contract", async () => {
  const offending = CATALOG_HOSTS[0]!;

  const envName = envKey(offending);
  const prior = process.env[envName];
  process.env[envName] = "shared-service-token";
  try {
    const ok = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "c3-ok-")) }));
    assert.equal(
      await ok.connectorTokens.connectorAccessToken(offending, "nobody"),
      null,
      "default wiring must hand out NO shared token for an unconnected catalog host",
    );

    const bad = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "c3-bad-")),
        egressServiceHosts: [offending],
      }),
    );
    assert.equal(
      await bad.connectorTokens.connectorAccessToken(offending, "nobody"),
      "shared-service-token",
      "listing a catalog host in egressServiceHosts leaks a shared token (the C3 violation a CI guard must catch)",
    );
    assert.notEqual(
      await ok.connectorTokens.connectorAccessToken(offending, "nobody"),
      await bad.connectorTokens.connectorAccessToken(offending, "nobody"),
      "a catalog host placed in serviceHosts is detectable: it changes the store's per-host token decision",
    );
  } finally {
    if (prior === undefined) delete process.env[envName];
    else process.env[envName] = prior;
  }
});

const SECRET = "invariant-secret".repeat(3);
const oauthEnv = { GOOGLE_OAUTH_CLIENT_ID: "gid", GOOGLE_OAUTH_CLIENT_SECRET: "gsecret" } as NodeJS.ProcessEnv;

test("cross-org — the callback rejects sealed state minted for a different org BEFORE exchange", async () => {
  let exchanged = false;
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "xorg-")), signingSecret: SECRET }));
  const server = createServer(built.app, {
    signingSecret: SECRET,
    replayDedupe: built.replayDedupe,
    connectorTokens: built.connectorTokens,
    oauthEnv,
    oauthFetch: async () => {
      exchanged = true;
      return { ok: true, status: 200, json: async () => ({ access_token: "leaked" }) };
    },
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const state = await sealOAuthState(
      {
        provider: "google",
        principalId: "U1",
        redirectUri: `${base}/v1/connectors/oauth/google/callback`,
        orgId: "other",
      },
      { secret: SECRET },
    );
    const res = await fetch(`${base}/v1/connectors/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /different org/);
    assert.equal(exchanged, false, "exchange must NOT run for a foreign-org state");
    assert.equal(await built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1"), null);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("empty-token guard — an adapter returning no access token fails the connect (nothing stored)", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "empty-")), signingSecret: SECRET }));
  const server = createServer(built.app, {
    signingSecret: SECRET,
    replayDedupe: built.replayDedupe,
    connectorTokens: built.connectorTokens,
    oauthEnv,
    oauthFetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const state = await sealOAuthState(
      { provider: "google", principalId: "U1", redirectUri: `${base}/v1/connectors/oauth/google/callback` },
      { secret: SECRET },
    );
    const res = await fetch(`${base}/v1/connectors/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /empty access token/);
    assert.equal(
      await built.connectorTokens.connectorAccessToken("gmail.googleapis.com", "U1"),
      null,
      "no dead credential persisted",
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("status/selector parity — a personal-only connection reports connected (matches the DM selector)", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "status-")) }));
  built.connectorTokens.setConnectorToken(
    "gmail.googleapis.com",
    "U1",
    { accessToken: "u1-personal", accountType: "personal" },
    "personal",
  );
  const server = createInsecureTestServer(built.app, { connectorTokens: built.connectorTokens });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const st = (await (await fetch(`${base}/v1/connectors/oauth/status?principalId=U1`)).json()) as {
      providers: Record<string, { connected: boolean }>;
    };
    assert.equal(
      st.providers.google!.connected,
      true,
      "status must reflect the personal token the orchestrator would inject in a DM",
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

function turn(kind: "dm" | "channel", text: string): TurnRequest {
  const actor = { externalId: "U1" };
  return kind === "dm"
    ? { surface: "test", actor, conversation: { kind: "dm", threadRef: "dm:U1" }, text }
    : {
        surface: "slack",
        actor,
        conversation: { kind: "channel", threadRef: "ch:C1", channelRef: "C1", audience: [actor] },
        text,
      };
}

test("F1/F3 — a live DM receives only its requested connector; a channel receives none", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "floor-")) }));
  await built.connectorTokens.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "u1-gmail" });
  const key = envKey("gmail.googleapis.com");
  const absent = `!run test -z "$${key}" && echo absent`;
  assert.equal((await built.app.turn({ ...turn("dm", absent), liveActor: true })).reply, "absent");
  const command = `test "$${key}" = u1-gmail && echo authenticated`;
  const selected = `!execute ${JSON.stringify({ command, credentials: ["connector_gmail_googleapis_com_default"] })}`;
  assert.equal((await built.app.turn({ ...turn("dm", selected), liveActor: true })).reply, "authenticated");
  assert.equal((await built.app.turn({ ...turn("dm", absent), liveActor: true })).reply, "absent");
  assert.equal((await built.app.turn(turn("channel", absent))).reply, "absent");
  await assert.rejects(built.app.turn(turn("channel", selected)), /not available/);
});

function wake(text: string, readOnly: boolean): TurnRequest {
  return {
    surface: "cron",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "agent:main:cron:c1" },
    text,
    triggered: true,
    ...(readOnly ? { readOnly: true } : {}),
  };
}

test("a triggered wake needs a grant and an explicit request for a connector", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "wake-conn-")) }));
  await built.connectorTokens.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "u1-gmail" });
  const key = envKey("gmail.googleapis.com");
  const absent = `!run test -z "$${key}" && echo absent`;
  assert.equal((await built.app.turn(wake(absent, false))).reply, "absent");
  const connector = (await built.keychain!.listConnectorsByOwners(["U1"])).get("U1")![0]!;
  const selected = `!execute ${JSON.stringify({ command: `test "$${key}" = u1-gmail && echo authenticated`, credentials: [credentialHandle(connector.credentialId)] })}`;
  await assert.rejects(built.app.turn(wake(selected, false)), /not available/);
  await built.keychain!.grantConnectorToScope({
    host: "gmail.googleapis.com",
    principalId: "U1",
    audienceScopeId: "personal:U1",
    purpose: "approved scheduled task",
  });
  assert.equal((await built.app.turn(wake(selected, false))).reply, "authenticated");
  assert.equal((await built.app.turn(wake(absent, false))).reply, "absent");
});

test("a read-only wake never reaches the sandbox (execute stripped), so no exec env at all", async () => {
  const built: BuiltApp = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "wake-ro-")) }));
  built.connectorTokens.setConnectorToken("gmail.googleapis.com", "U1", { accessToken: "u1-gmail" });

  fakeSprites.reset();
  const res = await built.app.turn(wake("[wake] glance only", true));
  assert.equal(res.status, "ok");
  assert.ok(
    !fakeSprites.calls.some((c) => c.method === "WS" && c.path.endsWith("/exec")),
    "a read-only wake spins no sandbox exec",
  );
});

for (const bulkInventory of [false, true])
  for (const expiredPersonal of [false, true]) {
    test(`connector catalog (${bulkInventory ? "bulk" : "independent store"}) exposes company and ${expiredPersonal ? "expired" : "live"} personal accounts without eager access`, async () => {
      const built = buildApp(
        testConfig({ dataDir: mkdtempSync(join(tmpdir(), "connector-accounts-")), maxAttempts: 1 }),
      );
      if (!bulkInventory) delete built.connectorTokens.listConnectorsByOwners;
      const host = "gmail.googleapis.com";
      await built.connectorTokens.setConnectorToken(
        host,
        "U1",
        { accessToken: "personal-token", expiresAt: Date.now() + (expiredPersonal ? -1000 : 3600000) },
        "personal",
      );
      await built.connectorTokens.setConnectorToken(
        host,
        "U1",
        { accessToken: "company-token", expiresAt: Date.now() + 3600000 },
        "company",
      );
      const accesses: Array<string | undefined> = [];
      const original = built.connectorTokens.connectorAccessToken.bind(built.connectorTokens);
      built.connectorTokens.connectorAccessToken = async (...args) => {
        accesses.push(args[2]);
        return original(...args);
      };
      const prompt = await built.app.turn({ ...turn("dm", "!sysprompt"), liveActor: true });
      assert.deepEqual(accesses, []);
      assert.match(prompt.reply ?? "", /connector_gmail_googleapis_com_company/);
      if (expiredPersonal) assert.doesNotMatch(prompt.reply ?? "", /connector_gmail_googleapis_com_personal/);
      else assert.match(prompt.reply ?? "", /connector_gmail_googleapis_com_personal/);
      for (const account of expiredPersonal ? ["company"] : ["personal", "company"]) {
        const text = `!execute ${JSON.stringify({ command: `test "$${envKey(host)}" = ${account}-token && echo selected`, credentials: [`connector_gmail_googleapis_com_${account}`] })}`;
        assert.equal((await built.app.turn({ ...turn("dm", text), liveActor: true })).reply, "selected");
      }
      assert.deepEqual(accesses, expiredPersonal ? ["company"] : ["personal", "company"]);
    });
  }

test("operator fallback forwards metadata without reading secret values", async () => {
  let reads = 0;
  const inventory = new Map([
    [
      "U1",
      [{ credentialId: "oauth", ownerId: "U1", host: "api.example.com", connected: true, accountType: "company" }],
    ],
  ]);
  const store = {
    listConnectorsByOwners: async () => inventory,
    connectorTokenStatus: async () => ({ connected: false }),
    connectorAccessToken: async () => null,
  } as unknown as ConnectorTokenStore;
  const wrapped = withOperatorTokenFallback(store, ["api.example.com"], {
    get: async () => {
      reads++;
      return "operator-fallback";
    },
  });
  assert.equal(await wrapped.listConnectorsByOwners!(["U1"]), inventory);
  assert.deepEqual(await wrapped.connectorTokenStatus("api.example.com", "U1"), { connected: false });
  assert.equal(reads, 0);
  assert.equal(await wrapped.connectorAccessToken("api.example.com", "U1"), "operator-fallback");
  assert.equal(reads, 1);
});

test("explicit default OAuth accounts remain discoverable through bulk metadata", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "default-account-")), maxAttempts: 1 }));
  const host = "gmail.googleapis.com";
  await built.connectorTokens.setConnectorToken(
    host,
    "U1",
    { accessToken: "explicit-default-token", accountType: "default" },
    "default",
  );
  Object.assign(
    built.connectorTokens,
    withOperatorTokenFallback(built.keychain!, [host], {
      get: async () => {
        throw new Error("healthy OAuth must not read an operator fallback");
      },
    }),
  );
  const prompt = await built.app.turn({ ...turn("dm", "!sysprompt"), liveActor: true });
  assert.match(prompt.reply ?? "", /connector_gmail_googleapis_com_default/);
  const text = `!execute ${JSON.stringify({ command: `test "$${envKey(host)}" = explicit-default-token && echo selected`, credentials: ["connector_gmail_googleapis_com_default"] })}`;
  assert.equal((await built.app.turn({ ...turn("dm", text), liveActor: true })).reply, "selected");
});

for (const mixedOAuth of [false, true, "expired-default"] as const)
  for (const value of [undefined, "operator-fallback-token"]) {
    test(`configured operator fallback is lazy with mixedOAuth=${mixedOAuth} and available=${value !== undefined}`, async () => {
      const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "fallback-catalog-")), maxAttempts: 1 }));
      const host = "gmail.googleapis.com";
      if (mixedOAuth === true)
        await built.connectorTokens.setConnectorToken(host, "U1", { accessToken: "personal-token" }, "personal");
      if (mixedOAuth === "expired-default")
        await built.connectorTokens.setConnectorToken(
          host,
          "U1",
          { accessToken: "expired-token", expiresAt: Date.now() - 1000, accountType: "default" },
          "default",
        );
      let reads = 0;
      Object.assign(
        built.connectorTokens,
        withOperatorTokenFallback(built.keychain!, ["googleapis.com"], {
          get: async () => {
            reads++;
            return value;
          },
        }),
      );
      const prompt = await built.app.turn({ ...turn("dm", "!sysprompt"), liveActor: true });
      assert.match(prompt.reply ?? "", /connector_gmail_googleapis_com_default.*configured operator fallback/);
      if (mixedOAuth === true) assert.match(prompt.reply ?? "", /connector_gmail_googleapis_com_personal/);
      assert.equal(reads, 0);
      const text = `!execute ${JSON.stringify({ command: `test "$${envKey(host)}" = operator-fallback-token && echo selected`, credentials: ["connector_gmail_googleapis_com_default"] })}`;
      if (value) assert.equal((await built.app.turn({ ...turn("dm", text), liveActor: true })).reply, "selected");
      else await assert.rejects(built.app.turn({ ...turn("dm", text), liveActor: true }), /no longer available/);
      assert.equal(reads, value ? 1 : 2);
    });
  }
