import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { appView, createApp } from "../src/api/app.ts";
import { createServer } from "../src/api/server.ts";
import { createDeployStore, WITHDRAW_LOANS_MIGRATION, type PublishedApp } from "../src/deploy/deploy-store.ts";
import { APP_TABLES } from "../src/deploy/page-views.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { testTenant } from "./support/test-tenant.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { personalScope, scopeId, type ScopeId } from "../src/types.ts";
import {
  CONTROL_PLANE_AUD,
  CREDENTIAL_BROKER_AUD,
  APP_CREDENTIAL_TTL_MS,
  mintCapabilityToken,
} from "../src/auth/capability-token.ts";
import type { AuditEvent } from "../src/audit/audit-log.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { testDatabaseUrl, testMap, testDeployBackings } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { liveRunClaims, liveRunStore } from "./support/live-run.ts";
import { signOffs } from "./support/signed-off-action.ts";
import type { PendingApprovalRecord } from "../src/types.ts";
import { createControlService } from "../src/api/control-service.ts";

const SIGNING = "s".repeat(64);
const PUBLISHER = "pub@example.com";
const CO_MANAGER = "co@example.com";
const tokenOf = (host: string) => `publisher-token-for-${host}`;

async function agent(t: { after: (fn: () => Promise<void>) => void }) {
  const audits: AuditEvent[] = [];
  const auditLog = {
    record: (_t: unknown, e: AuditEvent) => void audits.push(e),
    recordOnce: async (_t: unknown, _key: string, e: AuditEvent) => void audits.push(e),
    events: async () => [],
    tail: async () => [],
  };
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const deployStore = createDeployStore(testDeployBackings());
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore,
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
    auditLog,
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
  const signOff = signOffs({ getItems: async () => [] });
  const server = createServer(app, {
    sessions: signOff.sessions as never,
    approvals: testMap<PendingApprovalRecord>(),
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SIGNING,
    auditLog,
    runs: liveRunStore(),
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
  const call = async (path: string, token: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://localhost:${port}${path}`, {
      method: "POST",
      headers: { "x-agent-capability": token, "content-type": "application/json", ...headers },
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
      exp: Date.now() + APP_CREDENTIAL_TTL_MS,
    },
    SIGNING,
  );
  const broker = (body: Record<string, unknown>) => call("/v1/credentials/broker", appToken, body);
  const control = async (path: string, body: unknown, claims: object = {}, actorId = PUBLISHER, approved = false) =>
    call(
      path,
      await mintCapabilityToken(
        {
          actorId,
          scopeId: personalScope(actorId),
          aud: CONTROL_PLANE_AUD,
          ...liveRunClaims(actorId),
          sessionId: "dm:live",
          ...claims,
          exp: Date.now() + 60_000,
        },
        SIGNING,
      ),
      body,
      approved
        ? signOff.approve({ actorId, sessionId: "dm:live", runId: `live:${actorId}` }, { method: "POST", path, body })
        : {},
    );
  const lend = (actorId: string, connectors: unknown, approved = true) =>
    control(`/v1/apps/${d.id}/connectors`, { connectors }, {}, actorId, approved);
  return { d, app, deploy, deployStore, audits, upstream, broker, lend, control };
}

const get = (host: string, path = "/v1/me") => ({ connector: host, url: `https://${host}${path}` });

test("only the publisher can lend, with a signed-off card, per app and per connected-app host", async (t) => {
  const h = await agent(t);
  assert.equal((await h.broker(get("slack.com"))).json.error, "connector_not_lent", "nothing is lent by default");
  assert.equal((await h.lend(CO_MANAGER, ["slack.com"])).status, 403, "a co-manager cannot lend the publisher's");
  const card = await h.lend(PUBLISHER, ["slack.com"], false);
  assert.deepEqual([card.status, card.json.error], [202, "approval_required"], "lending raises an approval card");
  assert.equal((await h.broker(get("slack.com"))).json.error, "connector_not_lent", "an unapproved card lends nothing");
  const withoutAuthority = await h.control(
    `/v1/apps/${h.d.id}/connectors`,
    { connectors: ["slack.com"] },
    {
      personAuthority: false,
    },
  );
  assert.equal(withoutAuthority.json.error, "authority_required");
  assert.equal((await h.lend(PUBLISHER, ["evil.example.com"])).json.error, "unknown_connector");

  const lent = await h.lend(PUBLISHER, ["Slack.com", "gmail.googleapis.com"]);
  assert.deepEqual((lent.json.app as { connectors: string[] }).connectors, ["gmail.googleapis.com", "slack.com"]);
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

  const unshared = await h.app.appGrantees(h.d.id);
  const viaTool = await createControlService(h.app).shareArtifact(
    { type: "deploy", id: h.d.id, scope: "org" },
    {
      ...liveRunClaims(PUBLISHER),
      actorId: PUBLISHER,
      scopeId: personalScope(PUBLISHER),
      botActor: true,
      exp: Date.now() + 60_000,
    },
  );
  assert.equal(viaTool.ok || viaTool.code, "forbidden");
  assert.deepEqual(await h.app.appGrantees(h.d.id), unshared);
  for (const [path, body, claims] of [
    [`/v1/shares/deploy/${h.d.id}`, { scope: "org" }, { personAuthority: false }],
    ["/v1/share", { type: "deploy", id: h.d.id, toScope: personalScope(CO_MANAGER) }, { botActor: true }],
    [
      "/v1/share",
      { type: "deploy", id: h.d.id, toScope: personalScope("x@example.com"), move: true },
      { personAuthority: false },
    ],
  ] as const) {
    const before = await h.app.appGrantees(h.d.id);
    assert.equal((await h.control(path, body, claims)).status, 403);
    assert.equal((await h.control(path, body)).json.error, "approval_required");
    assert.deepEqual(await h.app.appGrantees(h.d.id), before);
    assert.equal((await h.control(path, body, {}, PUBLISHER, true)).status, 200);
    assert.notDeepEqual(await h.app.appGrantees(h.d.id), before);
  }
});

test("public apps cannot borrow connectors", async (t) => {
  const h = await agent(t);
  const publisher = { createdBy: PUBLISHER, signOff: async () => true };
  await h.app.setAppPublic(h.d.id, true, publisher);
  assert.match(String((await h.lend(PUBLISHER, ["slack.com"])).json.message), /public app cannot borrow/);
  await h.app.setAppPublic(h.d.id, false, publisher);
  await h.lend(PUBLISHER, ["slack.com"]);
  await assert.rejects(h.app.setAppPublic(h.d.id, true, publisher), /cannot be public/);
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
  await h.app.rollbackApp(h.d.id, 1, CO_MANAGER);
  assert.equal((await h.broker(get("slack.com"))).json.error, "connector_not_lent", "a rollback counts too");
});

test("moving the app out of its publisher's library withdraws the loan", async (t) => {
  const h = await agent(t);
  await h.lend(PUBLISHER, ["slack.com"]);
  await h.deploy.transferAppOwner(h.d.id, personalScope(CO_MANAGER), { callerId: PUBLISHER });
  assert.equal((await h.broker(get("slack.com"))).json.error, "connector_not_lent");
  assert.ok(h.audits.some((e) => e.action === "deploy_connectors" && e.detail?.includes("moved out of")));
  assert.match(String((await h.lend(PUBLISHER, ["slack.com"])).json.message), /outside its publisher's own library/);
  assert.equal((await h.lend(PUBLISHER, [])).status, 200, "withdrawing still works");
});

test("a loan left on an app outside its publisher's library is refused at use", async (t) => {
  const h = await agent(t);
  await h.lend(PUBLISHER, ["slack.com"]);
  assert.equal((await h.broker(get("slack.com"))).status, 200, "in the publisher's own library the loan works");
  await h.deployStore.setOwnerScope(h.d.id, scopeId("group", "home"));
  const sent = h.upstream.length;
  assert.equal((await h.broker(get("slack.com"))).json.error, "connector_not_lent");
  assert.equal(h.upstream.length, sent, "nothing leaves");
  assert.equal(appView((await h.app.getApp(h.d.id))!).connectors, undefined, "and the app lists no loan");
});

test("while the app borrows connectors, only the publisher can share it", async (t) => {
  const h = await agent(t);
  const d = await h.app.deploy({
    ownerScopeId: scopeId("group", "home"),
    createdBy: PUBLISHER,
    entrypoint: "x",
    files: [],
  });
  const lend = (connectors: string[]) =>
    h.deploy.setAppConnectors(d.id, connectors, { createdBy: PUBLISHER, signOff: async () => true });
  const share = (grantedBy: string) =>
    h.app.grant(
      testTenant,
      {
        ownerScopeId: d.ownerScopeId,
        ref: `deployment:${d.id}`,
        granteeScopeId: personalScope("outsider"),
        permission: "read",
        grantedBy,
      },
      { notify: false },
    );
  await h.deployStore.setConnectors(d.id, ["slack.com"]);
  await assert.rejects(share(CO_MANAGER), /only the person who published/);
  await share(PUBLISHER);
  await lend([]);
  await share(CO_MANAGER);
});

test("an upgrade withdraws loans on apps outside their publisher's library", async () => {
  const url = testDatabaseUrl();
  const apps = createPostgresMapFactory(url).map<PublishedApp>("deployments", undefined, APP_TABLES);
  const lent = (id: string, owner: string) =>
    ({
      id,
      createdBy: PUBLISHER,
      ownerScopeId: `personal:${owner}` as ScopeId,
      connectors: ["slack.com"],
    }) as PublishedApp;
  await apps.put("kept", lent("kept", PUBLISHER));
  await apps.put("moved", lent("moved", CO_MANAGER));
  const audit = createPostgresAuditLog(url);
  await audit.events(testTenant);
  const pg = createPgPool(url);
  await pg.migrate(WITHDRAW_LOANS_MIGRATION).finally(() => pg.close());
  assert.deepEqual((await apps.get("kept"))?.connectors, ["slack.com"]);
  assert.equal((await apps.get("moved"))?.connectors, undefined);
  assert.deepEqual(
    (await audit.events(testTenant)).map((e) => e.resource),
    ["deployment:moved"],
  );
});
