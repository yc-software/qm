import "./support/auto-fake-sprites.ts";
import { testTenant } from "./support/test-tenant.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import type { PublishedApp } from "../src/deploy/deploy-store.ts";
import type { AppPageViewLog } from "../src/deploy/page-views.ts";
import { scopeId } from "../src/types.ts";
import { serverDeps } from "../src/wiring.ts";
import { buildApp } from "./support/build-app.ts";
import { bill } from "./support/spend-usage.ts";
import { testConfig } from "./support/test-config.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";

const DAY = 86_400_000;
const sourceSecret = "source-only-secret".repeat(3);
const exportToken = "spend-export-only-token".repeat(3);
const today = Math.floor(Date.now() / DAY) * DAY;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const window = `from=${iso(today - DAY)}&to=${iso(today + DAY)}`;

const apps = "/v1/apps/export?principalId=alice%40example.com";

function fixture(options: { token?: string | null; sessions?: SessionStore | null; pageViews?: AppPageViewLog } = {}) {
  const built = buildApp(testConfig({ signingSecret: sourceSecret }));
  const sessions =
    options.sessions === null ? undefined : (options.sessions ?? createPostgresSessionStore(testDatabaseUrl()));
  const token = options.token === undefined ? exportToken : options.token;
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: sourceSecret,
    portalIdentitySecret: "portal-identity-secret".repeat(3),
    capabilitySecret: "capability-only-secret".repeat(3),
    requireSignedPortalIdentity: true,
    admin: built.admin,
    auditLog: built.auditLog,
    ...(sessions ? { sessions } : {}),
    ...(token ? { spendExportToken: token } : {}),
    ...(options.pageViews ? { appPageViews: options.pageViews } : {}),
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const get = (path: string, headers: Record<string, string> = { authorization: `Bearer ${exportToken}` }) =>
    fetch(base + path, { headers });
  return { built, sessions, get, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("spend export: absent unless a token is configured", async () => {
  const s = fixture({ token: null });
  try {
    assert.equal((await s.get(`/v1/spend/export?${window}`)).status, 404);
    assert.equal((await s.get(apps)).status, 404);
  } finally {
    await s.close();
  }
});

test("spend export: missing, wrong, admin-identity and source-signed requests are refused before any spend read", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  let reads = 0;
  store.spendRollup = async () => {
    reads++;
    return [];
  };
  const s = fixture({ sessions: store });
  try {
    s.built.app.listApps = async () => {
      reads++;
      return [];
    };
    for (const path of [`/v1/spend/export?${window}`, apps]) {
      const ts = Math.floor(Date.now() / 1000);
      const refused: Record<string, string>[] = [
        {},
        { authorization: `Bearer ${exportToken}x` },
        { authorization: exportToken },
        { authorization: `Bearer ${sourceSecret}` },
        { "x-admin-actor": "admin-alice@default-org" },
        { "x-timestamp": String(ts), "x-signature": signRequest(sourceSecret, ts, `GET\n${path}\n`) },
      ];
      for (const headers of refused) {
        const res = await s.get(path, headers);
        assert.equal(res.status, 401, JSON.stringify(headers));
      }
    }
    assert.equal(reads, 0);
    assert.deepEqual(await s.built.auditLog.events(testTenant), []);
  } finally {
    await s.close();
  }
});

test("app export: lists the person's live Apps page apps with their addresses", async () => {
  const s = fixture({
    pageViews: {
      record: async () => {},
      lastViews: async (_tenant, viewer) => new Map(viewer === "alice@example.com" ? [["live", 7]] : []),
    },
  });
  try {
    const app = (id: string, status: PublishedApp["status"]): PublishedApp => ({
      id,
      name: id,
      ownerScopeId: scopeId("personal", "bob@example.com"),
      createdBy: "bob@example.com",
      currentVersion: 1,
      status,
      endpoint: { host: "h", port: 1, publicUrl: `https://${id}.apps.example.com/?access=x` },
      versions: [{ version: 1, createdAt: 1, entrypoint: "x", snapshotDir: "/s" }],
    });
    const own = { ...app("own", "running"), ownerScopeId: scopeId("personal", "alice@example.com") };
    const given = {
      ...app("given", "running"),
      createdBy: "alice@example.com",
      ownerScopeId: scopeId("personal", "bob@example.com"),
    };
    const fleet = [app("live", "running"), app("gone", "archived"), own, given];
    s.built.app.listApps = async () => fleet;
    s.built.app.appGitPermissionsFor = async (_tenant, publishedApps, { actorId }) =>
      publishedApps.map(() => (actorId === "alice@example.com" ? "read" : null));
    assert.equal((await s.get("/v1/apps/export")).status, 400);
    const { principalId, deployments: publishedApps }: any = await (await s.get(apps)).json();
    assert.equal(principalId, "alice@example.com");
    const shown = { createdBy: "bob@example.com", permission: "read", updatedAt: 1 };
    assert.deepEqual(publishedApps, [
      { id: "live", name: "live", ...shown, url: "https://live.apps.example.com/", owned: false, viewedAt: 7 },
      { id: "own", name: "own", ...shown, url: "https://own.apps.example.com/", owned: true },
      {
        id: "given",
        name: "given",
        ...shown,
        createdBy: "alice@example.com",
        url: "https://given.apps.example.com/",
        owned: false,
      },
    ]);
    const events = (await s.built.auditLog.events(testTenant)).map((e) => [e.resource, e.detail]);
    assert.deepEqual(events, [["alice@example.com", "deployments=3"]]);
  } finally {
    await s.close();
  }
});

test("spend export: the token authorizes the export and nothing else", async () => {
  const s = fixture();
  try {
    for (const path of ["/v1/admin/spend", "/v1/admin/whoami", "/v1/admin/users"]) {
      const res = await s.get(path);
      assert.equal(res.status, 401, path);
    }
  } finally {
    await s.close();
  }
});

test("spend export: rows keep the ledger grain with canonical people, sources and the org scope, in code-point order", async () => {
  const s = fixture();
  try {
    const sessions = s.sessions!;
    await bill(sessions, "dm:alice:t1", "dm", scopeId("personal", "alice"), { costUsd: 2 }, "claude-opus-5");
    await bill(sessions, "dm:alice:t2", "dm", scopeId("personal", "alice"), { costUsd: 1 }, "claude-opus-5");
    await bill(sessions, "cron:nightly:fire:1", "dm", scopeId("personal", "alice"), { costUsd: 0.5 }, "gpt-6-astra");
    await bill(sessions, "webhook:w1", "channel", scopeId("channel", "C1"), { costUsd: 4 }, "claude-opus-5");
    await bill(sessions, "ch:C1:t1", "channel", scopeId("channel", "C1"), { costUsd: 3 }, "claude-opus-5");
    await bill(sessions, "dm:U1:t1", "dm", scopeId("personal", "U1"), { costUsd: 1 }, "claude-opus-5");
    const res = await s.get(`/v1/spend/export?${window}`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.scopeId, "org:default-org");
    assert.deepEqual(body.window, { from: iso(today - DAY), to: iso(today + DAY) });
    assert.deepEqual(
      body.rows.map((r: any) => [
        r.day,
        r.scopeId,
        r.kind,
        r.principalId,
        r.source,
        r.cronId,
        r.model,
        r.calls,
        r.costUsd,
      ]),
      [
        [iso(today), "channel:C1", "channel", null, "live", null, "claude-opus-5", 1, 3],
        [iso(today), "channel:C1", "channel", null, "webhook", null, "claude-opus-5", 1, 4],
        [iso(today), "personal:U1", "person", "U1", "live", null, "claude-opus-5", 1, 1],
        [iso(today), "personal:alice", "person", "alice", "live", null, "claude-opus-5", 2, 3],
        [iso(today), "personal:alice", "person", "alice", "cron", "nightly", "gpt-6-astra", 1, 0.5],
      ],
    );
    assert.deepEqual(
      [body.rows[3].input, body.rows[3].output, body.rows[3].cacheRead, body.rows[3].cacheWrite],
      [200, 40, 800, 80],
    );
    const audited = (await s.built.auditLog.events(testTenant)).filter((e) => e.action === "spend.export");
    assert.equal(audited.length, 1);
    assert.equal(audited[0]!.principalId, "spend-export");
    assert.equal(audited[0]!.detail, `${iso(today - DAY)}..${iso(today + DAY)} rows=5`);
  } finally {
    await s.close();
  }
});

test("spend export: lists each billed cron's title, owner and schedule without its task", async () => {
  const s = fixture();
  try {
    const cron = await s.built.app.createCron({
      ownerScopeId: "personal:alice",
      owner: "alice",
      createdBy: "alice",
      title: "Morning digest",
      schedule: { cron: "0 9 * * 1-5", timezone: "America/New_York" },
      action: "summarize my unread mail",
    });
    await s.built.app.createCron({
      ownerScopeId: "personal:alice",
      owner: "alice",
      createdBy: "alice",
      title: "Never billed",
      schedule: { everyMs: 60_000 },
      action: "idle",
    });
    await bill(s.sessions!, `cron:${cron.id}:fire:1`, "dm", scopeId("personal", "alice"), { costUsd: 2 }, "m1");
    await bill(s.sessions!, "cron:deleted:fire:1", "dm", scopeId("personal", "alice"), { costUsd: 1 }, "m1");
    const body: any = await (await s.get(`/v1/spend/export?${window}`)).json();
    assert.deepEqual(
      body.rows.map((r: any) => [r.cronId, r.costUsd]),
      [
        [cron.id, 2],
        ["deleted", 1],
      ].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
    );
    assert.deepEqual(body.crons, [
      {
        id: cron.id,
        title: "Morning digest",
        owner: "alice",
        ownerScopeId: "personal:alice",
        schedule: { cron: "0 9 * * 1-5", timezone: "America/New_York" },
        enabled: true,
      },
    ]);
  } finally {
    await s.close();
  }
});

test("spend export: passes through the saved report's freshness", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const asOf = Date.UTC(2026, 0, 1);
  store.spendReport = async (range) => ({ rows: await store.spendRollup(range), asOf });
  const s = fixture({ sessions: store });
  try {
    const body: any = await (await s.get(`/v1/spend/export?${window}`)).json();
    assert.equal(body.asOf, asOf);
    assert.deepEqual(body.rows, []);
  } finally {
    await s.close();
  }
});

test("spend export: the window is whole UTC days, ordered and at most 93 days", async () => {
  const s = fixture();
  try {
    for (const query of [
      "",
      `from=${iso(today)}`,
      `from=${today - DAY}&to=${today}`,
      `from=${iso(today)}&to=${iso(today)}`,
      `from=${iso(today)}&to=${iso(today - DAY)}`,
      `from=${iso(today - 94 * DAY)}&to=${iso(today)}`,
      "from=2026-02-30&to=2026-03-02",
    ]) {
      const res = await s.get(`/v1/spend/export?${query}`);
      assert.equal(res.status, 400, query);
    }
    assert.equal((await s.get(`/v1/spend/export?from=${iso(today - 93 * DAY)}&to=${iso(today)}`)).status, 200);
  } finally {
    await s.close();
  }
});

test("spend export: an unavailable spend store is an error, not an empty export", async () => {
  const s = fixture({ sessions: null });
  try {
    assert.equal((await s.get(`/v1/spend/export?${window}`)).status, 503);
  } finally {
    await s.close();
  }
});

test("spend export: core receives the configured token", () => {
  const config = testConfig({ spendExportToken: exportToken });
  assert.equal(serverDeps(config, buildApp(config)).spendExportToken, exportToken);
  assert.equal(serverDeps(testConfig(), buildApp(testConfig())).spendExportToken, undefined);
});
