import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { computeRetention } from "../src/admin/retention.ts";
import type { UserActivity } from "../src/identity/user-store.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const DAY = 86_400_000;
const at = (dayIdx: number, frac = 0.5) => Math.round((dayIdx + frac) * DAY);

const person = (principalId: string, sessions: number, turns: number, days: number[]): UserActivity => ({
  userId: null,
  principalId,
  kind: "person",
  sessions,
  turns,
  lastSeenAt: days.length ? at(Math.max(...days)) : null,
  days,
});

test("computeRetention: DAU/WAU/MAU, cohorts and new-vs-returning per person; apps and the never-active are not users", () => {
  const nowMs = at(1000);
  const report = computeRetention({
    nowMs,
    sessionCount: 4,
    activity: [
      person("U1", 1, 4, [960, 987, 994, 1000]),
      person("U2", 1, 1, [998]),
      person("U3", 1, 1, [1000]),
      person("U4", 1, 1, [1000]),
      person("U5", 1, 0, []),
      person("U6", 1, 1, [900]),
      { ...person("B1", 1, 9, [1000]), kind: "app" },
    ],
  });

  assert.deepEqual(report.active, { dau: 3, wau: 4, mau: 4, stickiness: 75 });
  assert.deepEqual(report.newVsReturning, { window: "30d", newUsers: 3, returning: 1 });
  assert.deepEqual(report.totals, { users: 5, sessions: 4 });
  assert.deepEqual(report.perUser.sessions, { p50: 1, p95: 1 });
  assert.deepEqual(report.perUser.turns, { p50: 1, p95: 4 });

  assert.equal(report.cohorts.length, 3);
  for (const cohort of report.cohorts) assert.equal(new Date(`${cohort.week}T00:00:00Z`).getUTCDay(), 1);
  assert.equal(report.cohorts[2]!.week, "1972-09-25");
  assert.deepEqual(report.cohorts[1]!.retained, [100, 0, 0, 0, 100]);
  assert.equal(report.cohorts[1]!.size, 1);
  assert.equal(report.cohorts[2]!.size, 3);
  assert.deepEqual(report.cohorts[2]!.retained, [100, 0, 0, 0, 0]);
});

test("computeRetention: empty input yields zeros, never NaN", () => {
  const report = computeRetention({ nowMs: at(1000), sessionCount: 0, activity: [] });
  assert.deepEqual(report.active, { dau: 0, wau: 0, mau: 0, stickiness: 0 });
  assert.deepEqual(report.perUser.turns, { p50: 0, p95: 0 });
  assert.deepEqual(report.cohorts, []);
  assert.deepEqual(report.totals, { users: 0, sessions: 0 });
});

function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-ret-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ALICE = { "x-admin-actor": "admin-alice@default-org" };
const get = (base: string, path: string, headers: Record<string, string> = ALICE) => fetch(base + path, { headers });

test("retention endpoint: org-wide, org_admin-gated, audited; non-org scopes rejected", async () => {
  const s = start();
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:t1" },
      text: "hello there",
    };
    assert.equal((await s.built.app.turn(dm)).status, "ok");

    const ok = await get(s.base, "/v1/admin/retention");
    assert.equal(ok.status, 200);
    const d = (await ok.json()) as any;
    assert.equal(d.scopeId, "org:default-org");
    assert.ok(d.active.dau >= 1, "the just-driven turn counts as active today");
    assert.ok(Array.isArray(d.cohorts), "cohorts present");
    assert.ok(d.perUser?.sessions && d.perUser?.turns, "per-user distributions present");
    assert.match(d.attribution, /approximate/, "the channel-attribution caveat is surfaced");

    assert.equal((await get(s.base, "/v1/admin/retention?scope=channel:eng")).status, 400);

    assert.equal((await get(s.base, "/v1/admin/retention", { "x-admin-actor": "user-uma@default-org" })).status, 403);
    assert.equal((await get(s.base, "/v1/admin/retention", { "x-admin-actor": "nobody@default-org" })).status, 403);

    assert.ok(
      (await s.built.auditLog.events()).some((e) => e.action === "retention.read"),
      "the read is audited",
    );
  } finally {
    await s.close();
  }
});
