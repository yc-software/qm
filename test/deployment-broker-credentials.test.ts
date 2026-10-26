import "./support/auto-fake-sprites.ts";
import { selectDefaultSandbox } from "./support/default-sandbox.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { loadConfig } from "../src/config.ts";
import { CAPABILITY_TTL_MS, CREDENTIAL_BROKER_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import type { BrokerFetch } from "../src/api/credential-broker.ts";
import { decisionsResource } from "../src/api/routes/decisions-resource.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import {
  deploymentBrokerCredentialsFromEnv,
  nonDeploymentCredential,
  withDeploymentCredentials,
  type DeploymentBrokerCredential,
} from "../src/credentials/deployment-credentials.ts";
import type { ServiceCredentialStore } from "../src/credentials/keychain.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "deployment-broker-secret".repeat(3);
const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const ORG = "org:default-org";
const KEY = "deployment-supplied-key";

const entry = {
  slug: "search",
  displayName: "Web search",
  host: "api.search.example",
  secretEnv: "SEARCH_KEY",
  injection: { header: "X-API-KEY", scheme: "" },
  allowedMethods: ["POST"],
  allowedPathPrefixes: ["/search"],
  maxRequestsPerDay: 2,
};
const envWith = (list: unknown, extra: Record<string, string> = {}) => ({
  BROKER_CREDENTIALS: JSON.stringify(list),
  SEARCH_KEY: KEY,
  ...extra,
});
const deploymentCreds = (): DeploymentBrokerCredential[] => deploymentBrokerCredentialsFromEnv(envWith([entry]));

test("BROKER_CREDENTIALS parses each entry and reads the secret from the named env var", () => {
  assert.deepEqual(deploymentBrokerCredentialsFromEnv({}), []);
  assert.deepEqual(deploymentCreds(), [
    {
      slug: "search",
      name: "Web search",
      secret: KEY,
      host: "api.search.example",
      injection: { header: "X-API-KEY", scheme: "" },
      allowedMethods: ["POST"],
      allowedPathPrefixes: ["/search"],
      maxRequestsPerDay: 2,
    },
  ]);
  const minimal = deploymentBrokerCredentialsFromEnv(
    envWith([{ slug: "news", host: "news.example.com", secretEnv: "SEARCH_KEY" }]),
  );
  assert.deepEqual(minimal, [{ slug: "news", name: "news", secret: KEY, host: "news.example.com" }]);
});

test("BROKER_CREDENTIALS fails fast on any malformed entry without echoing secrets", () => {
  const cases: Array<[unknown, RegExp, Record<string, string>?]> = [
    [{ nope: 1 }, /must be a JSON array/],
    [["x"], /must be an object/],
    [[{ ...entry, secret: "inline" }], /unknown field "secret"/],
    [[{ ...entry, slug: "Bad Slug" }], /slug must be lowercase/],
    [[entry, entry], /more than once/],
    [[{ ...entry, host: "https://api.search.example/v1" }], /bare lowercase hostname/],
    [[{ ...entry, host: "backend.composio.dev" }], /Composio/],
    [[{ ...entry, secretEnv: "lower" }], /secretEnv/],
    [[{ ...entry, secretEnv: "MISSING_KEY" }], /MISSING_KEY is unset or empty/],
    [[{ ...entry, allowedMethods: ["get"] }], /allowedMethods is invalid/],
    [[{ ...entry, allowedPathPrefixes: ["search"] }], /allowedPathPrefixes is invalid/],
    [[{ ...entry, maxRequestsPerDay: 0 }], /maxRequestsPerDay/],
    [[{ ...entry, maxRequestsPerDay: 1.5 }], /maxRequestsPerDay/],
    [[{ ...entry, injection: { header: "x-qm-actor" } }], /reserved/],
    [
      [{ ...entry, injection: { ...entry.injection, headers: ["x-api-version"] } }],
      /injection.headers must be an object/,
    ],
    [[{ ...entry, injection: { ...entry.injection, headers: { "x api": "1" } } }], /not a valid HTTP header name/],
    [[{ ...entry, injection: { ...entry.injection, headers: { Host: "evil.example" } } }], /cannot set host/],
    [
      [{ ...entry, injection: { ...entry.injection, headers: { "Content-Type": "text/plain" } } }],
      /cannot set content-type/,
    ],
    [[{ ...entry, injection: { ...entry.injection, headers: { Expect: "100-continue" } } }], /cannot set expect/],
    [[{ ...entry, injection: { ...entry.injection, headers: { Upgrade: "websocket" } } }], /cannot set upgrade/],
    [[{ ...entry, injection: { ...entry.injection, headers: { "x-v": "a\u0001b" } } }], /valid HTTP header value/],
    [[{ ...entry, injection: { ...entry.injection, headers: { "x-api-key": "1" } } }], /cannot set x-api-key/],
    [[{ ...entry, injection: { headers: { Authorization: "Bearer other" } } }], /cannot set authorization/],
    [[{ ...entry, injection: { ...entry.injection, headers: { "x-v": "1", "X-V": "2" } } }], /more than once/],
    [
      [{ ...entry, injection: { ...entry.injection, headers: { "x-v": "1\r\nx-evil: 1" } } }],
      /valid HTTP header value/,
    ],
    [[{ ...entry, injection: { ...entry.injection, headers: { "x-v": "" } } }], /valid HTTP header value/],
    [[{ ...entry, displayName: "" }], /displayName/],
  ];
  for (const [list, pattern, extra] of cases) {
    assert.throws(
      () => deploymentBrokerCredentialsFromEnv(envWith(list, extra)),
      (error: Error) => pattern.test(error.message) && !error.message.includes(KEY),
      String(pattern),
    );
  }
  assert.throws(() => deploymentBrokerCredentialsFromEnv({ BROKER_CREDENTIALS: "{oops" }), /JSON array/);
  assert.throws(
    () => loadConfig({ ...envWith([{ ...entry, secretEnv: "MISSING_KEY" }]) }),
    /BROKER_CREDENTIALS "search": env var MISSING_KEY/,
  );
});

function memoryStore(): ServiceCredentialStore & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    getServiceCredentialSecret: async (_scope, slug) =>
      slug === "search" || slug === "stored"
        ? {
            slug,
            name: "Stored",
            secret: "db-secret",
            delivery: "broker",
            host: "db.example.com",
            deployments: true,
            enabled: true,
          }
        : null,
    listServiceCredentials: async () =>
      ["search", "stored"].map((slug) => ({
        slug,
        name: "Stored",
        delivery: "broker" as const,
        host: "db.example.com",
        deployments: true,
        enabled: true,
        hasSecret: true,
        updatedAt: 1,
      })),
    setServiceCredential: async (_scope, input) => void writes.push(`set:${input.slug}`),
    setServiceCredentialIfAbsent: async (_scope, input) => (writes.push(`absent:${input.slug}`), 1),
    setServiceCredentialIfCurrent: async (_scope, input) => (writes.push(`current:${input.slug}`), 2),
    deleteServiceCredential: async (_scope, slug) => void writes.push(`delete:${slug}`),
    deleteServiceCredentialIfCurrent: async (_scope, slug) => (writes.push(`deleteIf:${slug}`), true),
  };
}

test("deployment credentials win lookups in their org and reserve their slugs against stored writes", async () => {
  const stored = memoryStore();
  const store = withDeploymentCredentials(stored, ORG, deploymentCreds());

  const listed = await store.listServiceCredentials(ORG);
  assert.deepEqual(
    listed.map((c) => [c.slug, c.source, c.host]),
    [
      ["search", "deployment", "api.search.example"],
      ["stored", undefined, "db.example.com"],
    ],
  );
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(KEY));
  assert.equal(listed[0]!.deployments, false);
  assert.equal((await store.getServiceCredentialSecret(ORG, "search"))?.secret, KEY);
  assert.equal((await store.getServiceCredentialSecret(ORG, "search"))?.source, "deployment");
  assert.equal((await store.getServiceCredentialSecret(ORG, "stored"))?.source, undefined);
  assert.equal(nonDeploymentCredential(await store.getServiceCredentialSecret(ORG, "search")), null);
  assert.equal(nonDeploymentCredential(await store.getServiceCredentialSecret(ORG, "stored"))?.secret, "db-secret");
  assert.equal((await store.getServiceCredentialSecret(ORG, "stored"))?.secret, "db-secret");
  assert.equal((await store.getServiceCredentialSecret("org:other", "search"))?.secret, "db-secret");
  assert.equal((await store.listServiceCredentials("org:other")).length, 2);

  const input = { slug: "search", name: "x", host: "evil.example.com", secret: "s" };
  await assert.rejects(store.setServiceCredential(ORG, input), /supplied by this deployment/);
  await assert.rejects(store.setServiceCredentialIfAbsent(ORG, input), /supplied by this deployment/);
  await assert.rejects(store.setServiceCredentialIfCurrent(ORG, input, 1), /supplied by this deployment/);
  await assert.rejects(store.deleteServiceCredential(ORG, "search"), /supplied by this deployment/);
  await assert.rejects(store.deleteServiceCredentialIfCurrent(ORG, "search", 1), /supplied by this deployment/);
  await store.setServiceCredential(ORG, { ...input, slug: "stored" });
  assert.deepEqual(stored.writes, ["set:stored"]);
});

function start(fetchImpl: BrokerFetch, admin = false, brokerCredentials = deploymentCreds()) {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "deploy-broker-")),
      signingSecret: SECRET,
      brokerCredentials,
    }),
  );
  const deps = {
    config: built.config,
    serviceCreds: built.serviceCreds,
    acl: built.acl,
    credentialUsage: built.credentialUsage,
    admin: built.admin,
    auditLog: built.auditLog,
    brokerFetch: fetchImpl,
  };
  const server = admin
    ? createInsecureTestServer(built.app, deps)
    : createServer(built.app, { ...deps, signingSecret: SECRET });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("admin settings show a deployment credential read-only and refuse to edit, delete or shadow it", async () => {
  const srv = start(async () => ({ status: 200, text: async () => "{}" }), true);
  try {
    const cfg = (await (await fetch(`${srv.base}/v1/admin/scopes/${ORG}`, { headers: ADMIN })).json()) as {
      serviceCredentials: Array<{ slug: string; source?: string; hasSecret: boolean; maxRequestsPerDay?: number }>;
    };
    const search = cfg.serviceCredentials.find((c) => c.slug === "search");
    assert.equal(search?.source, "deployment");
    assert.equal(search?.hasSecret, true);
    assert.equal(search?.maxRequestsPerDay, 2);
    assert.doesNotMatch(JSON.stringify(cfg), new RegExp(KEY));

    for (const body of [
      { slug: "search", name: "Mine", host: "evil.example.com", secret: "s" },
      { slug: "search", name: "Mine", host: "api.search.example", expectedUpdatedAt: 0 },
      { slug: "search", delete: true, expectedUpdatedAt: 0 },
    ]) {
      const res = await fetch(`${srv.base}/v1/admin/scopes/${ORG}/service-credentials`, {
        method: "PUT",
        headers: ADMIN,
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 409);
      const json = (await res.json()) as { error?: string; message?: string };
      assert.equal(json.error, "deployment_credential");
      assert.match(String(json.message), /supplied by this deployment/);
    }
  } finally {
    await srv.close();
  }
});

test("the broker serves a deployment credential with its pins, injection, usage log and daily cap", async () => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const srv = start(async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers });
    return { status: 200, contentType: "application/json", text: async () => '{"ok":true}' };
  });
  try {
    const token = await mintCapabilityToken(
      {
        actorId: "U1",
        scopeId: "personal:U1",
        aud: CREDENTIAL_BROKER_AUD,
        credentials: ["search"],
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
      SECRET,
    );
    const call = async (method: string, url: string) => {
      const res = await fetch(`${srv.base}/v1/credentials/broker`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agent-capability": token },
        body: JSON.stringify({ credential: "search", method, url }),
      });
      return { status: res.status, body: (await res.json()) as { error?: string } };
    };
    assert.equal((await call("POST", "https://evil.example.com/search")).status, 403);
    assert.equal((await call("GET", "https://api.search.example/search")).status, 403);
    assert.equal((await call("POST", "https://api.search.example/admin")).status, 403);
    assert.equal((await call("POST", "https://api.search.example/search?q=1")).status, 200);
    assert.equal((await call("POST", "https://api.search.example/search?q=2")).status, 200);
    const capped = await call("POST", "https://api.search.example/search?q=3");
    assert.equal(capped.status, 429);
    assert.equal(capped.body.error, "daily_cap_reached");
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.headers["X-API-KEY"], KEY);
    assert.equal(calls[0]!.headers["x-api-version"], undefined);
    const usage = await srv.built.credentialUsage.list({ slug: "search" });
    assert.equal(usage.filter((u) => u.status === "ok").length, 2);
    assert.equal(usage.filter((u) => u.status === "denied").length, 4);
  } finally {
    await srv.close();
  }
});

const dm = (text: string): TurnRequest => ({
  surface: "test",
  actor: { externalId: "U1" },
  conversation: { kind: "dm", threadRef: "dm:U1:t1" },
  text,
});

test("org members' agents get a deployment credential by broker only, as if granted org-wide", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "deploy-broker-stamp-")),
      maxAttempts: 1,
      signingSecret: SECRET,
      apiBaseUrl: "http://core.internal",
      brokerCredentials: deploymentCreds(),
    }),
  );
  let executed: Record<string, string> | undefined;
  const realRun = built.sandbox.run.bind(built.sandbox);
  built.sandbox.run = (handle, command, opts) => {
    if (command === "echo hi") executed = handle.env;
    return realRun(handle, command, opts);
  };
  await selectDefaultSandbox(built, "U1", "personal:U1");
  const prompt = await built.app.turn(dm("!sysprompt"));
  assert.match(prompt.reply ?? "", /search.*Web search.*api\.search\.example.*POST.*\/search/s);
  const res = await built.app.turn(dm(`!execute ${JSON.stringify({ command: "echo hi", credentials: ["search"] })}`));
  assert.equal(res.status, "ok", res.reason);
  assert.ok(executed?.AGENT_CREDENTIAL_TOKEN, "expected a broker token");
  assert.doesNotMatch(JSON.stringify(executed), new RegExp(KEY));
});

test("a deployment credential cannot back a decision provider", async () => {
  const saved: unknown[] = [];
  const serviceCreds = withDeploymentCredentials(memoryStore(), ORG, deploymentCreds());
  const ctx = (body: unknown) =>
    ({
      body,
      deps: {
        serviceCreds,
        decisions: {
          saveProvider: async (provider: unknown) => void saved.push(provider),
          providers: async () => [],
          rules: async () => [],
        },
      },
    }) as unknown as ApiCtx;
  const provider = (credential: string) => ({
    provider: { id: "p", protocol: "decisions", baseUrl: "https://api.search.example/search", credential },
  });
  const refused = await decisionsResource.apply!(ctx(provider("search")), { id: "admin" } as never, ORG);
  assert.match(String((refused as { error?: string }).error), /supplied by this deployment/);
  assert.deepEqual(saved, []);
  await decisionsResource.apply!(ctx(provider("stored")), { id: "admin" } as never, ORG);
  assert.equal(saved.length, 1);
  const listing = (await decisionsResource.get!(ctx({}).deps, ORG)) as { credentials: string[] };
  assert.deepEqual(listing.credentials, ["stored"]);
});

test("the broker adds a deployment credential's fixed headers, which callers cannot override", async () => {
  const pinned = {
    ...entry,
    slug: "versioned",
    injection: { ...entry.injection, headers: { "x-api-version": "2025-11-01" } },
  };
  const calls: Array<Record<string, string>> = [];
  const srv = start(
    async (_url, init) => {
      calls.push(init.headers);
      return { status: 200, contentType: "application/json", text: async () => "{}" };
    },
    false,
    deploymentBrokerCredentialsFromEnv(envWith([pinned])),
  );
  try {
    const token = await mintCapabilityToken(
      {
        actorId: "U1",
        scopeId: "personal:U1",
        aud: CREDENTIAL_BROKER_AUD,
        credentials: ["versioned"],
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
      SECRET,
    );
    const res = await fetch(`${srv.base}/v1/credentials/broker`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": token },
      body: JSON.stringify({
        credential: "versioned",
        method: "POST",
        url: "https://api.search.example/search",
        headers: { "X-Api-Version": "1999-01-01", "content-type": "application/json", "x-api-key": "caller" },
        body: "{}",
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls[0], { "content-type": "application/json", "x-api-version": "2025-11-01", "X-API-KEY": KEY });
  } finally {
    await srv.close();
  }
});
