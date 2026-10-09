import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { LlmCallUsage, SessionStore } from "../src/sessions/session-store.ts";
import { scopeId, type SessionType } from "../src/types.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const DAY = 86_400_000;
const sourceSecret = "source-only-secret".repeat(3);
const exportToken = "spend-export-only-token".repeat(3);
const today = Math.floor(Date.now() / DAY) * DAY;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const window = `from=${iso(today - DAY)}&to=${iso(today + DAY)}`;

function fixture(options: { token?: string | null; sessions?: SessionStore | null } = {}) {
  const built = buildApp(testConfig({ signingSecret: sourceSecret }));
  const sessions = options.sessions === null ? undefined : (options.sessions ?? createMemorySessionStore());
  const token = options.token === undefined ? exportToken : options.token;
  const server = createServer(built.app, {
    signingSecret: sourceSecret,
    portalIdentitySecret: "portal-identity-secret".repeat(3),
    capabilitySecret: "capability-only-secret".repeat(3),
    requireSignedPortalIdentity: true,
    admin: built.admin,
    auditLog: built.auditLog,
    ...(sessions ? { sessions } : {}),
    ...(token ? { spendExportToken: token } : {}),
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const get = (path: string, headers: Record<string, string> = { authorization: `Bearer ${exportToken}` }) =>
    fetch(base + path, { headers });
  return { built, sessions, get, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const usage = (costUsd: number): LlmCallUsage => ({
  input: 100,
  output: 20,
  cacheRead: 400,
  cacheWrite: 40,
  totalTokens: 560,
  costUsd,
});

async function bill(
  sessions: SessionStore,
  threadRef: string,
  type: SessionType,
  scope: string,
  costUsd: number,
  model: string,
) {
  const session = await sessions.getOrCreateByThread(threadRef, type, scope);
  await sessions.recordLlmRequest(session.id, {
    turnSeq: null,
    step: 0,
    model,
    scopeLabel: scope,
    usage: usage(costUsd),
  });
}

test("spend export: absent unless a token is configured", async () => {
  const s = fixture({ token: null });
  try {
    const res = await s.get(`/v1/spend/export?${window}`);
    assert.equal(res.status, 404);
  } finally {
    await s.close();
  }
});

test("spend export: missing, wrong, admin-identity and source-signed requests are refused before any spend read", async () => {
  const store = createMemorySessionStore();
  let reads = 0;
  store.spendRollup = async () => {
    reads++;
    return [];
  };
  const s = fixture({ sessions: store });
  try {
    const path = `/v1/spend/export?${window}`;
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
    assert.equal(reads, 0);
    assert.deepEqual(
      (await s.built.auditLog.events()).filter((e) => e.action === "spend.export"),
      [],
    );
  } finally {
    await s.close();
  }
});

test("spend export: the token authorizes the export and nothing else", async () => {
  const s = fixture();
  try {
    for (const path of ["/v1/admin/spend", "/v1/admin/whoami", "/v1/admin/users", "/v1/background-work"]) {
      const res = await s.get(path);
      assert.equal(res.status, 401, path);
    }
  } finally {
    await s.close();
  }
});

test("spend export: rows keep the ledger grain with canonical people, origin buckets and the org scope", async () => {
  const s = fixture();
  try {
    const sessions = s.sessions!;
    await bill(sessions, "dm:alice:t1", "dm", scopeId("personal", "alice"), 2, "claude-opus-5");
    await bill(sessions, "dm:alice:t2", "dm", scopeId("personal", "alice"), 1, "claude-opus-5");
    await bill(sessions, "cron:nightly:fire:1", "dm", scopeId("personal", "alice"), 0.5, "gpt-6-astra");
    await bill(sessions, "webhook:w1", "channel", scopeId("channel", "C1"), 4, "claude-opus-5");
    await bill(sessions, "ch:C1:t1", "channel", scopeId("channel", "C1"), 3, "claude-opus-5");
    const res = await s.get(`/v1/spend/export?${window}`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.scopeId, "org:default-org");
    assert.deepEqual(body.window, { from: iso(today - DAY), to: iso(today + DAY) });
    assert.deepEqual(
      body.rows.map((r: any) => [r.day, r.scopeId, r.kind, r.principalId, r.origin, r.model, r.calls, r.costUsd]),
      [
        [iso(today), "channel:C1", "channel", null, "live", "claude-opus-5", 1, 3],
        [iso(today), "channel:C1", "channel", null, "background", "claude-opus-5", 1, 4],
        [iso(today), "personal:alice", "person", "alice", "live", "claude-opus-5", 2, 3],
        [iso(today), "personal:alice", "person", "alice", "cron", "gpt-6-astra", 1, 0.5],
      ],
    );
    assert.deepEqual(
      [body.rows[2].input, body.rows[2].output, body.rows[2].cacheRead, body.rows[2].cacheWrite],
      [200, 40, 800, 80],
    );
    const audited = (await s.built.auditLog.events()).filter((e) => e.action === "spend.export");
    assert.equal(audited.length, 1);
    assert.equal(audited[0]!.principalId, "spend-export");
    assert.equal(audited[0]!.detail, `${iso(today - DAY)}..${iso(today + DAY)} rows=4`);
  } finally {
    await s.close();
  }
});

test("spend export: passes through the saved report's freshness", async () => {
  const store = createMemorySessionStore();
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
