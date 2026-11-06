import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/app.ts";
import { createServer } from "../src/api/server.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { personalScope } from "../src/types.ts";
import {
  CONTROL_PLANE_AUD,
  CREDENTIAL_BROKER_AUD,
  DEPLOYMENT_CREDENTIAL_TTL_MS,
  mintCapabilityToken,
} from "../src/auth/capability-token.ts";
import type { AuditEvent } from "../src/audit/audit-log.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { testDatabaseUrl, testMap, testDeployBackings } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";

const SIGNING = "s".repeat(64);
const PUBLISHER = "pub@example.com";
const CO_MANAGER = "co@example.com";
const tokenOf = (host: string) => `publisher-token-for-${host}`;

async function agent(t: { after: (fn: () => Promise<void>) => void }) {
  const audits: AuditEvent[] = [];
  const auditLog = {
    record: (e: AuditEvent) => void audits.push(e),
    recordOnce: async (_key: string, e: AuditEvent) => void audits.push(e),
    events: async () => [],
    tail: async () => [],
  };
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore: createDeployStore(testDeployBackings()),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 1 }),
      destroy: async () => {},
    },
    auditLog,
    acl,
    externalSharingAllowed: async () => true,
    deployDir: mkdtempSync(join(tmpdir(), "connector-lending-")),
  });
  const app = createApp({
    deploy,
    acl,
    directory: createPostgresDirectoryStore(testDatabaseUrl()),
    sessions: createPostgresSessionStore(testDatabaseUrl()),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
  } as unknown as Parameters<typeof createApp>[0]);
  const d = await app.deploy({
    ownerScopeId: personalScope(PUBLISHER),
    createdBy: PUBLISHER,
    entrypoint: "x",
    files: [],
    name: "mailer",
  });
  const upstream: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const server = createServer(app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SIGNING,
    auditLog,
    keychain: {
      connectorAccessToken: async (host: string, principalId: string, accountType?: string) =>
        principalId === PUBLISHER && accountType === "personal" && host !== "api.dropboxapi.com" ? tokenOf(host) : null,
    } as never,
    brokerFetch: async (url, init) => {
      upstream.push({ url, ...init });
      return { status: 200, contentType: "application/json", text: async () => '{"ok":true}' };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const call = async (path: string, token: string, body: unknown) => {
    const res = await fetch(`http://localhost:${port}${path}`, {
      method: "POST",
      headers: { "x-agent-capability": token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const appToken = await mintCapabilityToken(
    {
      actorId: PUBLISHER,
      scopeId: personalScope(PUBLISHER),
      aud: CREDENTIAL_BROKER_AUD,
      credentials: [],
      deployment: d.id,
      exp: Date.now() + DEPLOYMENT_CREDENTIAL_TTL_MS,
    },
    SIGNING,
  );
  const broker = (body: Record<string, unknown>) => call("/v1/credentials/broker", appToken, body);
  const lend = async (actorId: string, connectors: unknown, liveActor = true) =>
    call(
      `/v1/deployments/${d.id}/connectors`,
      await mintCapabilityToken(
        {
          actorId,
          scopeId: personalScope(actorId),
          aud: CONTROL_PLANE_AUD,
          ...(liveActor ? { liveActor: true } : {}),
          exp: Date.now() + 60_000,
        },
        SIGNING,
      ),
      { connectors },
    );
  return { d, app, audits, upstream, broker, lend };
}

const get = (host: string, path = "/v1/me") => ({ connector: host, url: `https://${host}${path}` });

test("only the live publisher can lend, per app and per connected-app host", async (t) => {
  const h = await agent(t);
  assert.equal((await h.broker(get("slack.com"))).json.error, "connector_not_lent", "nothing is lent by default");
  assert.equal((await h.lend(CO_MANAGER, ["slack.com"])).status, 403, "a co-manager cannot lend the publisher's");
  assert.equal((await h.lend(PUBLISHER, ["slack.com"], false)).status, 403, "an unattended turn cannot lend");
  assert.equal((await h.lend(PUBLISHER, ["evil.example.com"])).json.error, "unknown_connector");

  const lent = await h.lend(PUBLISHER, ["Slack.com", "gmail.googleapis.com"]);
  assert.deepEqual((lent.json.deployment as { connectors: string[] }).connectors, [
    "gmail.googleapis.com",
    "slack.com",
  ]);
  assert.equal((await h.broker(get("api.dropboxapi.com"))).json.error, "connector_not_lent", "only the hosts lent");

  for (const host of ["gmail.googleapis.com", "slack.com"]) {
    const res = await h.broker({
      ...get(host, "/api/do"),
      method: "POST",
      body: "{}",
      headers: { authorization: "x" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { status: 200, contentType: "application/json", body: '{"ok":true}' });
    const sent = h.upstream.at(-1)!;
    assert.equal(sent.method, "POST", "every method acts as the publisher; the app gates who may trigger it");
    assert.equal(sent.headers.authorization, `Bearer ${tokenOf(host)}`, "the broker injects the publisher's token");
    assert.ok(!JSON.stringify(res.json).includes(tokenOf(host)), "the token never reaches the app");
  }

  const before = h.upstream.length;
  for (const [url, error] of [
    ["https://evil.example.com/v1", "host_not_allowed"],
    ["http://slack.com/api", "scheme_not_allowed"],
    ["https://slack.com:8443/api", "scheme_not_allowed"],
    ["https://slack.com/api/%252e%252e/admin", "path_not_allowed"],
  ] as const)
    assert.equal((await h.broker({ connector: "slack.com", url })).json.error, error);
  assert.equal(h.upstream.length, before, "refused calls never leave");

  await h.lend(PUBLISHER, ["gmail.googleapis.com", "api.dropboxapi.com"]);
  assert.equal((await h.broker(get("api.dropboxapi.com"))).json.error, "connector_unavailable");
  await h.lend(PUBLISHER, []);
  assert.equal((await h.broker(get("gmail.googleapis.com"))).json.error, "connector_not_lent", "[] withdraws");

  const trail = h.audits.map((e) => `${e.action} ${e.resource} ${e.detail ?? ""}`);
  assert.ok(
    trail.some((l) => /^connector\.broker\.use slack\.com deployment:\S+ POST \/api\/do upstream:200$/.test(l)),
  );
  assert.ok(trail.some((l) => l.startsWith("connector.broker.denied slack.com") && l.endsWith("host_not_allowed")));
  assert.ok(trail.some((l) => /^deploy_connectors \S+ gmail\.googleapis\.com,slack\.com$/.test(l)));
  assert.ok(trail.some((l) => /^deploy_connectors \S+ \(none\)$/.test(l)));
});

test("public apps cannot borrow connectors", async (t) => {
  const h = await agent(t);
  await h.app.setDeploymentPublic(h.d.id, true, { createdBy: PUBLISHER });
  assert.match(String((await h.lend(PUBLISHER, ["slack.com"])).json.message), /public app cannot borrow/);
  await h.app.setDeploymentPublic(h.d.id, false, { createdBy: PUBLISHER });
  await h.lend(PUBLISHER, ["slack.com"]);
  await assert.rejects(h.app.setDeploymentPublic(h.d.id, true, { createdBy: PUBLISHER }), /cannot be public/);
});

test("a new running version from anyone but the publisher withdraws the loan", async (t) => {
  const h = await agent(t);
  await h.lend(PUBLISHER, ["slack.com"]);
  await h.app.redeploy(h.d.id, { entrypoint: "x", files: [], actor: PUBLISHER });
  assert.equal((await h.broker(get("slack.com"))).status, 200, "the publisher's own publish keeps it");

  await h.app.redeploy(h.d.id, { entrypoint: "x", files: [], actor: CO_MANAGER });
  assert.equal((await h.broker(get("slack.com"))).json.error, "connector_not_lent");
  assert.ok(h.audits.some((e) => e.action === "deploy_connectors" && e.principalId === CO_MANAGER));

  await h.lend(PUBLISHER, ["slack.com"]);
  await h.app.rollbackDeployment(h.d.id, 1, CO_MANAGER);
  assert.equal((await h.broker(get("slack.com"))).json.error, "connector_not_lent", "a rollback counts too");
});
