import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { cacheHitRatio } from "../src/admin/metrics-sink.ts";
import { buildApp } from "../src/wiring.ts";
import { scopeId, type SessionType, type TurnRequest } from "../src/types.ts";
import type { LlmCallUsage, SessionStore } from "../src/sessions/session-store.ts";
import { testConfig } from "./support/test-config.ts";

const DAY = 86_400_000;
const ALICE = { "x-admin-actor": "admin-alice@default-org" };
const RANDO = { "x-admin-actor": "rando@default-org" };
const ORG = "org:default-org";

function start(sessions?: SessionStore) {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-spend-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: sessions ?? built.sessions,
    auditLog: built.auditLog,
    metrics: built.metrics,
    runs: built.runs,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const get = (base: string, path: string, headers: Record<string, string> = ALICE) => fetch(base + path, { headers });
const getJson = async (base: string, path: string, headers: Record<string, string> = ALICE): Promise<any> =>
  (await get(base, path, headers)).json();

const dm = (principal: string, text: string): TurnRequest => ({
  surface: "test",
  actor: { externalId: principal },
  conversation: { kind: "dm", threadRef: `dm:${principal}:t1` },
  text,
});

const usage = (over: Partial<LlmCallUsage>): LlmCallUsage => ({
  input: 100,
  output: 20,
  cacheRead: 400,
  cacheWrite: 40,
  totalTokens: 560,
  costUsd: 0,
  ...over,
});

async function bill(
  sessions: SessionStore,
  threadRef: string,
  type: SessionType,
  scope: string,
  over: Partial<LlmCallUsage>,
  model = "mock",
): Promise<void> {
  const session = await sessions.getOrCreateByThread(threadRef, type, scope);
  await sessions.recordLlmRequest(session.id, {
    turnSeq: null,
    step: 0,
    model,
    scopeLabel: scope,
    usage: usage(over),
  });
}

async function seedPricedFixture(sessions: SessionStore): Promise<void> {
  await bill(sessions, "dm:alice:priced", "dm", scopeId("personal", "alice"), { costUsd: 2 });
  await bill(sessions, "cron:nightly:fire:abc123", "dm", scopeId("personal", "alice"), { costUsd: 0.5 });
  await bill(sessions, "dm:bob:priced", "dm", scopeId("personal", "bob"), { costUsd: 1.25 });
  await bill(sessions, "ch:C1:priced", "channel", scopeId("channel", "C1"), { costUsd: 3 });
}

const conserved = (report: any, column: string): number =>
  [...report.people, ...report.scopes].reduce((sum: number, e: any) => sum + e[column], 0);

test("spend: uses the saved report and exposes its freshness", async () => {
  const store = createMemorySessionStore();
  const asOf = Date.UTC(2026, 0, 1);
  let reads = 0;
  store.spendReport = async (range) => {
    reads++;
    return { rows: await store.spendRollup(range), asOf };
  };
  const s = start(store);
  try {
    await seedPricedFixture(store);
    const body = await getJson(s.base, "/v1/admin/spend");
    assert.equal(body.asOf, asOf);
    assert.equal(body.org.costUsd, 6.75);
    const csv = await get(s.base, "/v1/admin/spend?format=csv");
    assert.equal(csv.status, 200);
    assert.equal(reads, 2);
  } finally {
    await s.close();
  }
});

test("spend: live and cron dollars land on the owning person, shared scopes on their own rows", async () => {
  const s = start();
  try {
    assert.equal((await s.built.app.turn(dm("alice", "hello there"))).status, "ok");
    assert.equal((await s.built.app.turn(dm("bob", "hello there"))).status, "ok");
    await seedPricedFixture(s.built.sessions);

    const body = await getJson(s.base, "/v1/admin/spend");
    assert.equal(body.scopeId, ORG);
    assert.equal(body.window.bucket, "day");

    const alice = body.people.find((p: any) => p.principalId === "alice");
    const bob = body.people.find((p: any) => p.principalId === "bob");
    assert.ok(alice && bob, "both principals appear with the ids the Users page shows");
    assert.ok(alice.live.costUsd > 0 && alice.cron.costUsd > 0, "alice carries both live and cron dollars");
    assert.equal(bob.cron.costUsd, 0, "bob never ran a cron");
    assert.equal(alice.cron.costUsd, 0.5, "the cron is billed to its scope owner, not to a speaker");

    assert.deepEqual(
      body.scopes.map((e: any) => [e.principalId, e.scopeId, e.kind, e.costUsd]),
      [[null, "channel:C1", "channel", 3]],
    );
  } finally {
    await s.close();
  }
});

test("spend: people plus shared scopes reconcile to the org totals", async () => {
  const s = start();
  try {
    assert.equal((await s.built.app.turn(dm("alice", "hello there"))).status, "ok");
    await seedPricedFixture(s.built.sessions);

    const body = await getJson(s.base, "/v1/admin/spend");
    assert.ok(Math.abs(conserved(body, "costUsd") - body.org.costUsd) <= 1e-9);
    for (const column of ["calls", "tokens", "input", "output", "cacheRead", "cacheWrite"]) {
      assert.equal(conserved(body, column), body.org[column], column);
    }
    assert.equal(
      body.org.cacheHitRatio,
      cacheHitRatio({ cacheRead: body.org.cacheRead, cacheWrite: body.org.cacheWrite, uncachedInput: body.org.input }),
    );
    for (const person of body.people) {
      assert.ok(
        person.cacheHitRatio === null || (person.cacheHitRatio >= 0 && person.cacheHitRatio <= 1),
        "a per-person ratio is a real fraction or null",
      );
    }
  } finally {
    await s.close();
  }
});

test("spend: a mock-harness turn shows zero dollars with its tokens intact", async () => {
  const s = start();
  try {
    assert.equal((await s.built.app.turn(dm("codexlike", "hello there"))).status, "ok");
    const body = await getJson(s.base, "/v1/admin/spend");
    const row = body.people.find((p: any) => p.principalId === "codexlike");
    assert.ok(row, "a scope whose harness books no dollars is still listed");
    assert.equal(row.costUsd, 0);
    assert.ok(row.tokens > 0, "tokens are a separate column, so $0 turns stay visible");
    assert.ok(row.cacheHitRatio !== null && row.cacheHitRatio >= 0 && row.cacheHitRatio <= 1);
  } finally {
    await s.close();
  }
});

test("spend: a window in the past excludes today's rows entirely", async () => {
  const s = start();
  try {
    assert.equal((await s.built.app.turn(dm("alice", "hello there"))).status, "ok");
    await seedPricedFixture(s.built.sessions);

    const now = await getJson(s.base, "/v1/admin/spend");
    assert.ok(now.org.costUsd > 0);
    const past = await getJson(s.base, "/v1/admin/spend?from=2020-01-01&to=2020-02-01");
    assert.deepEqual(past.window, { from: "2020-01-01", to: "2020-02-01", bucket: "day" });
    assert.equal(past.org.costUsd, 0);
    assert.equal(past.org.calls, 0);
    assert.deepEqual(past.people, []);
    assert.deepEqual(past.scopes, []);
    assert.deepEqual(past.series, []);
  } finally {
    await s.close();
  }
});

test("spend: from/to and bucket=week reshape the series over backdated rows", async () => {
  const clock = { at: Date.UTC(2026, 0, 5, 12) };
  const store = createMemorySessionStore({ now: () => clock.at });
  const s = start(store);
  try {
    await bill(store, "dm:alice:d1", "dm", scopeId("personal", "alice"), { costUsd: 2 });
    await bill(store, "ch:C1:d1", "channel", scopeId("channel", "C1"), { costUsd: 1 });
    clock.at += DAY;
    await bill(store, "dm:alice:d2", "dm", scopeId("personal", "alice"), { costUsd: 4 });
    await bill(store, "cron:nightly:fire:abc123", "dm", scopeId("personal", "alice"), { costUsd: 0.5 });

    const both = await getJson(s.base, "/v1/admin/spend?from=2026-01-05&to=2026-01-07");
    assert.deepEqual(
      both.series.map((p: any) => p.day),
      ["2026-01-05", "2026-01-06"],
    );
    for (const point of both.series) assert.match(point.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(both.org.costUsd, 7.5);

    const dayTwo = await getJson(s.base, "/v1/admin/spend?from=2026-01-06&to=2026-01-07");
    assert.deepEqual(
      dayTwo.series.map((p: any) => p.day),
      ["2026-01-06"],
    );
    assert.equal(dayTwo.org.costUsd, 4.5);
    assert.ok(dayTwo.org.costUsd < both.org.costUsd, "a narrower window cannot report more spend");
    assert.deepEqual(
      dayTwo.people.map((p: any) => p.principalId),
      ["alice"],
      "day one's channel row falls outside [from, to)",
    );
    assert.deepEqual(dayTwo.scopes, []);

    const weekly = await getJson(s.base, "/v1/admin/spend?from=2026-01-05&to=2026-01-07&bucket=week");
    assert.deepEqual(
      weekly.series.map((p: any) => [p.day, p.costUsd]),
      [["2026-01-05", 7.5]],
      "both UTC days collapse into the Monday-aligned week that contains them",
    );
    assert.equal(weekly.window.bucket, "week");
  } finally {
    await s.close();
  }
});

test("spend: ?format=csv exports the same numbers for the same window", async () => {
  const clock = { at: Date.UTC(2026, 0, 5, 12) };
  const store = createMemorySessionStore({ now: () => clock.at });
  const s = start(store);
  try {
    await seedPricedFixture(store);
    const query = "from=2026-01-05&to=2026-01-06";
    const json = await getJson(s.base, `/v1/admin/spend?${query}`);
    const r = await get(s.base, `/v1/admin/spend?${query}&format=csv`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(r.headers.get("content-disposition")!, /^attachment; filename="qm-spend-2026-01-05-2026-01-06\.csv"/);
    const body = await r.text();
    assert.equal(Number(r.headers.get("content-length")), Buffer.byteLength(body));

    const lines = body.trimEnd().split("\r\n");
    assert.equal(
      lines[0],
      "principal_id,scope_id,kind,display_name,live_usd,cron_usd,background_usd,total_usd,calls,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cache_hit_ratio",
    );
    assert.equal(lines.length, json.people.length + json.scopes.length + 1);
    const alice = lines.find((l) => l.startsWith("alice,"))!.split(",");
    assert.equal(Number(alice[7]), json.people.find((p: any) => p.principalId === "alice").costUsd);
  } finally {
    await s.close();
  }
});

test("spend: a caller with no admin grant gets 403 and writes no audit event, JSON or CSV", async () => {
  const s = start();
  try {
    for (const path of [
      "/v1/admin/spend",
      "/v1/admin/spend?format=csv",
      "/v1/admin/spend?format=csv&breakdown=model",
    ]) {
      const r = await get(s.base, path, RANDO);
      assert.equal(r.status, 403);
      assert.equal(r.headers.get("content-type"), "application/json");
      const body = (await r.json()) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ["error", "message"]);
    }
    assert.equal(
      (await s.built.auditLog.events()).filter((e) => e.action === "spend.read").length,
      0,
      "a rejected read leaves no spend.read trail",
    );

    assert.equal((await get(s.base, "/v1/admin/spend")).status, 200);
    assert.equal((await get(s.base, "/v1/admin/spend?format=csv")).status, 200);
    const audited = (await s.built.auditLog.events()).filter((e) => e.action === "spend.read");
    assert.equal(audited.length, 2, "both formats audit under the same action");
    for (const event of audited) assert.equal(event.resource, "spend");
  } finally {
    await s.close();
  }
});

test("spend: malformed windows are rejected instead of silently defaulted", async () => {
  const s = start();
  try {
    for (const query of [
      "from=not-a-date",
      "from=9007199254740991",
      "to=9007199254740991",
      "from=2026-02-30",
      "to=2026-13-01",
      "to=yesterday",
      "from=2026-01-05&to=2026-01-05",
      "from=2026-01-06&to=2026-01-05",
      "bucket=fortnight",
      "format=xlsx",
      "breakdown=provider",
      "breakdown=",
      "format=csv&breakdown=provider",
      "to=99999999999999999999",
    ]) {
      const r = await get(s.base, `/v1/admin/spend?${query}`);
      assert.equal(r.status, 400, query);
      assert.equal(((await r.json()) as { error: string }).error, "bad_request", query);
    }
  } finally {
    await s.close();
  }
});

test("spend: an empty deployment answers 200 with zeroed totals", async () => {
  const s = start();
  try {
    const body = await getJson(s.base, "/v1/admin/spend");
    assert.equal(body.org.costUsd, 0);
    assert.equal(body.org.calls, 0);
    assert.equal(body.org.cacheHitRatio, null);
    assert.deepEqual(body.people, []);
    assert.deepEqual(body.scopes, []);
    assert.deepEqual(body.series, []);
    assert.deepEqual(body.models, []);
  } finally {
    await s.close();
  }
});

test("spend: model CSV selects the model breakdown with its own filename", async () => {
  const clock = { at: Date.UTC(2026, 0, 5, 12) };
  const store = createMemorySessionStore({ now: () => clock.at });
  const s = start(store);
  try {
    await seedPricedFixture(store);
    await bill(store, "dm:alice:priced", "dm", scopeId("personal", "alice"), { costUsd: 4 }, "other-model");
    const query = "from=2026-01-05&to=2026-01-06&breakdown=model";
    const json = await getJson(s.base, `/v1/admin/spend?${query}`);
    assert.deepEqual(
      json.models.map((m: any) => [m.model, m.costUsd]),
      [
        ["mock", 6.75],
        ["other-model", 4],
      ],
    );
    const r = await get(s.base, `/v1/admin/spend?${query}&format=csv`);
    assert.equal(r.status, 200);
    assert.match(
      r.headers.get("content-disposition")!,
      /^attachment; filename="qm-spend-models-2026-01-05-2026-01-06\.csv"/,
    );
    const body = await r.text();
    assert.equal(Number(r.headers.get("content-length")), Buffer.byteLength(body));
    const lines = body.trimEnd().split("\r\n");
    assert.equal(lines.length, json.models.length + 1);
    for (const [i, model] of json.models.entries()) {
      const cells = lines[i + 1]!.split(",");
      assert.equal(cells[0], model.model);
      assert.equal(Number(cells[4]), model.costUsd);
      assert.equal(Number(cells[5]), model.calls);
    }
    assert.equal(
      json.models.reduce((sum: number, m: any) => sum + m.costUsd, 0),
      json.org.costUsd,
    );
  } finally {
    await s.close();
  }
});
