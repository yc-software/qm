import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-egress-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    credentialUsage: built.credentialUsage,
    egressAudit: built.egressAudit,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ALICE = { "x-admin-actor": "admin-alice@default-org" };
const getJson = async (base: string, path: string, headers: Record<string, string> = ALICE): Promise<any> =>
  (await fetch(base + path, { headers })).json();

test("egress: brokered calls surface as scope-labelled audit records, org-wide", async () => {
  const s = start();
  try {
    s.built.credentialUsage.record({
      slug: "x-firehose",
      host: "api.x.com",
      status: "ok",
      upstreamStatus: 200,
      scopeLabel: "personal:U1",
      principalId: "U1",
    });
    s.built.credentialUsage.record({
      slug: "x-firehose",
      host: "api.x.com",
      status: "denied",
      scopeLabel: "personal:U2",
      principalId: "U2",
    });

    const d = await getJson(s.base, "/v1/admin/egress?scope=org:default-org");
    assert.equal(d.scopeId, "org:default-org");
    assert.equal(d.total, 2, "both brokered calls counted");
    assert.equal(d.denied, 1, "the denied call is tallied");
    assert.equal(d.hosts, 1, "distinct host count");
    assert.equal(d.records.length, 2);

    const r = d.records[0];
    assert.equal(r.source, "broker", "records are attributed to the broker path");
    assert.equal(typeof r.ts, "number");
    for (const k of ["allowed", "host", "scopeLabel", "principalId", "slug", "status"])
      assert.ok(k in r, `record carries ${k}`);

    const denied = d.records.find((x: any) => x.status === "denied");
    assert.equal(denied.allowed, false, "a denied broker call reads as not-allowed");
    assert.equal(denied.scopeLabel, "personal:U2");
    const ok = d.records.find((x: any) => x.status === "ok");
    assert.equal(ok.allowed, true);
    assert.equal(ok.upstreamStatus, 200, "upstream status is surfaced");

    assert.ok(
      (await s.built.auditLog.events()).some((e) => e.action === "egress.read"),
      "the egress read is itself audited",
    );
  } finally {
    await s.close();
  }
});

test("egress: broker and firewall sources are unioned into one feed", async () => {
  const s = start();
  try {
    s.built.credentialUsage.record({
      slug: "x-firehose",
      host: "api.x.com",
      status: "ok",
      upstreamStatus: 200,
      scopeLabel: "personal:U1",
      principalId: "U1",
    });
    s.built.egressAudit.record({
      source: "proxy",
      host: "pastebin.com",
      allowed: false,
      verdict: "host_denied",
      via: "connect",
      port: 443,
      peerIp: "1.2.3.4",
      scopeLabel: "personal:U1",
    });

    const d = await getJson(s.base, "/v1/admin/egress?scope=org:default-org");
    assert.equal(d.total, 2, "both sources counted in one feed");
    assert.deepEqual(d.bySource, { broker: 1, firewall: 1 });
    assert.equal(d.denied, 1, "the firewall block is tallied as denied");
    assert.equal(d.hosts, 2, "two distinct hosts across sources");

    assert.deepEqual(d.records.map((r: any) => r.source).sort(), ["broker", "proxy"], "records carry their producer");
    const fw = d.records.find((r: any) => r.source === "proxy");
    assert.equal(fw.allowed, false);
    assert.equal(fw.status, "host_denied", "the proxy verdict surfaces as status");
    assert.equal(fw.host, "pastebin.com");
    assert.equal(fw.via, "connect");
    assert.equal(fw.port, 443);
  } finally {
    await s.close();
  }
});

test("egress: a scoped read returns only that scope's records, across both sources", async () => {
  const s = start();
  try {
    s.built.credentialUsage.record({
      slug: "a",
      host: "api.a.com",
      status: "ok",
      scopeLabel: "personal:U1",
      principalId: "U1",
    });
    s.built.credentialUsage.record({
      slug: "b",
      host: "api.b.com",
      status: "ok",
      scopeLabel: "personal:U2",
      principalId: "U2",
    });
    s.built.egressAudit.record({
      source: "proxy",
      host: "fw.a.com",
      allowed: true,
      verdict: "ok",
      scopeLabel: "personal:U1",
    });
    s.built.egressAudit.record({
      source: "proxy",
      host: "fw.b.com",
      allowed: true,
      verdict: "ok",
      scopeLabel: "personal:U2",
    });

    const d = await getJson(s.base, "/v1/admin/egress?scope=personal:U1");
    assert.equal(d.total, 2, "the broker + firewall rows for this scope, and nothing else");
    assert.deepEqual(d.bySource, { broker: 1, firewall: 1 });
    assert.ok(
      d.records.every((r: any) => r.scopeLabel === "personal:U1"),
      "both sinks are scope-filtered",
    );
    assert.deepEqual(d.records.map((r: any) => r.host).sort(), ["api.a.com", "fw.a.com"]);
  } finally {
    await s.close();
  }
});

test("egress: an empty scope is not an error", async () => {
  const s = start();
  try {
    const d = await getJson(s.base, "/v1/admin/egress?scope=personal:nobody");
    assert.equal(d.total, 0);
    assert.deepEqual(d.records, []);
    assert.equal(d.denied, 0);
    assert.equal(d.hosts, 0);
  } finally {
    await s.close();
  }
});

test("egress: authz is the boundary (scope grant required, scope required)", async () => {
  const s = start();
  try {
    assert.equal(
      (
        await fetch(s.base + "/v1/admin/egress?scope=org:default-org", {
          headers: { "x-admin-actor": "user-uma@default-org" },
        })
      ).status,
      403,
    );
    assert.equal((await fetch(s.base + "/v1/admin/egress", { headers: ALICE })).status, 400);
  } finally {
    await s.close();
  }
});

test("egress-audit ingest: proxy-relayed decisions land as firewall rows in the admin view", async () => {
  const s = start();
  try {
    const res = await fetch(s.base + "/v1/egress-audit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        records: [
          { host: "api.github.com", verdict: "ok", scopeLabel: "personal:U1", principalId: "U1" },
          { host: "pastebin.com", verdict: "host_denied", allowed: true, scopeLabel: "personal:U1" },
          { verdict: "ok" },
        ],
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { accepted: 2, rejected: 1 });

    const d = await getJson(s.base, "/v1/admin/egress?scope=org:default-org");
    assert.equal(d.bySource.firewall, 2);
    const denied = d.records.find((r: any) => r.host === "pastebin.com");
    assert.equal(denied.source, "proxy", "ingested rows are attributed to the proxy regardless of body");
    assert.equal(denied.allowed, false, "allowed is derived from the verdict, not trusted from the body");
    assert.equal(denied.status, "host_denied");
  } finally {
    await s.close();
  }
});

test("egress-audit ingest: a hostile over-long hostname is truncated, never dropped", async () => {
  const s = start();
  try {
    const res = await fetch(s.base + "/v1/egress-audit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        records: [{ host: `${"a".repeat(600)}.attacker.example`, verdict: "denied", scopeLabel: "personal:U1" }],
      }),
    });
    assert.deepEqual(await res.json(), { accepted: 1, rejected: 0 });
    const d = await getJson(s.base, "/v1/admin/egress?scope=org:default-org");
    assert.equal(d.records[0].host.length, 512, "the row survives, truncated");
  } finally {
    await s.close();
  }
});

test("egress-audit ingest: an oversized or empty batch is rejected", async () => {
  const s = start();
  try {
    const post = (body: unknown) =>
      fetch(s.base + "/v1/egress-audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal((await post({ records: [] })).status, 400);
    assert.equal((await post({})).status, 400);
    assert.equal(
      (await post({ records: Array.from({ length: 501 }, () => ({ host: "a.com", verdict: "ok" })) })).status,
      400,
    );
  } finally {
    await s.close();
  }
});
