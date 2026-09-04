import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresCredentialUsageSink } from "../src/admin/postgres-credential-usage-sink.ts";
import { scopeId } from "../src/types.ts";
import { settle } from "./support/settle.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres credential-usage tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS credential_usage CASCADE");
  await p.end();
});

test(
  "pg credential-usage sink: persists broker calls, filters by scope/slug/since, newest-first",
  { skip },
  async () => {
    const sink = createPostgresCredentialUsageSink(URL!);
    const s1 = scopeId("personal", "U1");
    const s2 = scopeId("personal", "U2");

    sink.record({
      slug: "x-firehose",
      host: "api.x.com",
      status: "ok",
      upstreamStatus: 200,
      scopeLabel: s1,
      principalId: "U1",
    });
    sink.record({ slug: "serp", host: "serpapi.com", status: "denied", scopeLabel: s2, principalId: "U2" });
    await settle(async () => (await sink.list({ limit: 100 })).length === 2);

    const all = await sink.list({ limit: 100 });
    assert.equal(all.length, 2, "both brokered calls persisted");
    assert.equal(all[0]!.scopeLabel, s2, "newest first");
    assert.equal(all[0]!.status, "denied");
    assert.equal(all[0]!.upstreamStatus, undefined, "an absent upstream status stays absent (not 0)");

    const onlyS1 = await sink.list({ scopeId: s1, limit: 100 });
    assert.equal(onlyS1.length, 1, "scope filter narrows to one");
    assert.equal(onlyS1[0]!.host, "api.x.com");
    assert.equal(onlyS1[0]!.slug, "x-firehose");
    assert.equal(onlyS1[0]!.upstreamStatus, 200, "captured upstream status round-trips");
    assert.equal(onlyS1[0]!.principalId, "U1");

    const onlySlug = await sink.list({ slug: "serp", limit: 100 });
    assert.equal(onlySlug.length, 1, "slug filter narrows to one");
    assert.equal(onlySlug[0]!.scopeLabel, s2);

    const future = await sink.list({ since: Date.now() + 60_000, limit: 100 });
    assert.equal(future.length, 0, "nothing at/after a future cutoff");
  },
);

test("pg credential-usage sink: survives a fresh sink over the same table (durability)", { skip }, async () => {
  const reopened = createPostgresCredentialUsageSink(URL!);
  const rows = await reopened.list({ limit: 100 });
  assert.ok(rows.length >= 2, "calls written by a prior sink instance are still readable");
});
