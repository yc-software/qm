import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresEgressAuditSink } from "../src/admin/postgres-egress-audit-sink.ts";
import { scopeId } from "../src/types.ts";
import { settle } from "./support/settle.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres egress-audit tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS egress_events CASCADE");
  await p.end();
});

test(
  "pg egress-audit sink: persists firewall decisions, filters by scope/source/since, newest-first",
  { skip },
  async () => {
    const sink = createPostgresEgressAuditSink(URL!);
    const s1 = scopeId("personal", "U1");
    const s2 = scopeId("personal", "U2");

    sink.record({
      source: "proxy",
      host: "api.github.com",
      allowed: true,
      verdict: "ok",
      via: "connect",
      port: 443,
      peerIp: "140.82.121.6",
      scopeLabel: s1,
      principalId: "U1",
    });
    sink.record({
      source: "proxy",
      host: "pastebin.com",
      allowed: false,
      verdict: "host_denied",
      via: "connect",
      port: 443,
      scopeLabel: s2,
    });
    await settle(async () => (await sink.list({ limit: 100 })).length === 2);

    const all = await sink.list({ limit: 100 });
    assert.equal(all.length, 2, "both decisions persisted");
    assert.equal(all[0]!.scopeLabel, s2, "newest first");
    assert.equal(all[0]!.allowed, false);
    assert.equal(all[0]!.verdict, "host_denied");
    assert.equal(all[0]!.peerIp, undefined, "an absent peerIp stays absent (not empty string)");
    assert.equal(all[0]!.principalId, undefined, "a per-scope (not per-principal) row keeps principalId absent");

    const onlyS1 = await sink.list({ scopeId: s1, limit: 100 });
    assert.equal(onlyS1.length, 1, "scope filter narrows to one");
    assert.equal(onlyS1[0]!.host, "api.github.com");
    assert.equal(onlyS1[0]!.allowed, true);
    assert.equal(onlyS1[0]!.port, 443, "captured port round-trips");
    assert.equal(onlyS1[0]!.peerIp, "140.82.121.6", "the pinned dial IP round-trips");
    assert.equal(onlyS1[0]!.principalId, "U1");

    const onlySource = await sink.list({ source: "proxy", limit: 100 });
    assert.equal(onlySource.length, 2, "source filter matches both proxy rows");

    const future = await sink.list({ since: Date.now() + 60_000, limit: 100 });
    assert.equal(future.length, 0, "nothing at/after a future cutoff");
  },
);

test("pg egress-audit sink: survives a fresh sink over the same table (durability)", { skip }, async () => {
  const reopened = createPostgresEgressAuditSink(URL!);
  const rows = await reopened.list({ limit: 100 });
  assert.ok(rows.length >= 2, "decisions written by a prior sink instance are still readable");
});
