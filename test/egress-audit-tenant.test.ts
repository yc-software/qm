import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { withRequestTenant } from "../src/api/request-tenant.ts";
import { egressAuditRoutes } from "../src/api/routes/egress-audit.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import type { EgressAuditRecord } from "../src/admin/egress-audit-sink.ts";
import { bindBootTenant } from "../src/tenants/boot.ts";
import { createPostgresEgressAuditSink } from "../src/admin/postgres-egress-audit-sink.ts";
import type { EgressAuditSink } from "../src/admin/egress-audit-sink.ts";
import { assertRowsByTenant, describeTwoTenants } from "./support/two-tenants.ts";
import { settle } from "./support/settle.ts";
import { boundTenant, withoutTenant } from "../src/tenants/context.ts";
import { tenantLookup } from "../src/tenants/lookup.ts";

const SECRET = "egress-audit-tenant-capability-secret".repeat(2);
const a = randomUUID();
const b = randomUUID();
const route = egressAuditRoutes[0]!;

before(() => bindBootTenant(async () => undefined));

const known = (tenants: readonly string[]) => ({
  tenantLookup: { exists: async (tenant: string) => tenants.includes(tenant) },
});

async function ingest(
  records: unknown[],
  persist?: EgressAuditSink,
  sessions: unknown = known([a, b]),
): Promise<{ status: number; body: unknown; saved: Array<{ host: string; tenant: string | undefined }> }> {
  const saved: Array<{ host: string; tenant: string | undefined }> = [];
  const egressAudit = {
    record: (r: Omit<EgressAuditRecord, "ts">) => {
      saved.push({ host: r.host, tenant: boundTenant() });
      persist?.record(r);
    },
    list: async () => [],
  };
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      void withRequestTenant(req, res, route, SECRET, undefined, () =>
        route.handle({ res, body, deps: { egressAudit, sessions } } as unknown as ApiCtx),
      );
    });
  });
  server.listen(0);
  try {
    const response = await fetch(`http://localhost:${(server.address() as AddressInfo).port}/v1/egress-audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ records }),
    });
    return { status: response.status, body: await response.json(), saved };
  } finally {
    server.close();
  }
}

test("egress-audit ingest on a multitenant core saves each record under the tenant it names", () =>
  withoutTenant(async () => {
    const result = await ingest([
      { host: "a.example", verdict: "ok", scopeLabel: "personal:U1", tenant: a },
      { host: "b.example", verdict: "denied", scopeLabel: "personal:U1", tenant: b },
    ]);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { accepted: 2, rejected: 0 });
    assert.deepEqual(result.saved, [
      { host: "a.example", tenant: a },
      { host: "b.example", tenant: b },
    ]);
  }));

test("egress-audit ingest rejects records with no tenant or a malformed one when the core has several tenants", () =>
  withoutTenant(async () => {
    const result = await ingest([
      { host: "none.example", verdict: "ok", scopeLabel: "personal:U1" },
      { host: "bad.example", verdict: "ok", scopeLabel: "personal:U1", tenant: "not-a-tenant" },
      { host: "a.example", verdict: "ok", scopeLabel: "personal:U1", tenant: a },
    ]);
    assert.deepEqual(result.body, { accepted: 1, rejected: 2 });
    assert.deepEqual(result.saved, [{ host: "a.example", tenant: a }]);
  }));

test("egress-audit ingest rejects a well-formed tenant id the core does not have", () =>
  withoutTenant(async () => {
    const result = await ingest([
      { host: "ghost.example", verdict: "ok", scopeLabel: "personal:U1", tenant: randomUUID() },
      { host: "a.example", verdict: "ok", scopeLabel: "personal:U1", tenant: a },
    ]);
    assert.deepEqual(result.body, { accepted: 1, rejected: 1 });
    assert.deepEqual(result.saved, [{ host: "a.example", tenant: a }]);
  }));

test("egress-audit ingest on a single-tenant core files tenantless records under the boot tenant only", () =>
  withoutTenant(async () => {
    await bindBootTenant(async () => b);
    try {
      const result = await ingest([
        { host: "old.example", verdict: "ok", scopeLabel: "personal:U1" },
        { host: "a.example", verdict: "ok", scopeLabel: "personal:U1", tenant: a },
      ]);
      assert.deepEqual(result.body, { accepted: 2, rejected: 0 });
      assert.deepEqual(result.saved, [
        { host: "old.example", tenant: b },
        { host: "a.example", tenant: a },
      ]);
    } finally {
      await bindBootTenant(async () => undefined);
    }
  }));

describeTwoTenants("egress-audit ingest under row-level security", (db) => {
  test("each tenant's proxy decisions persist in its own rows", () =>
    withoutTenant(async () => {
      const sink = createPostgresEgressAuditSink(db.appDatabaseUrl);
      const [first, second] = db.tenants;
      const result = await ingest(
        [
          { host: "first.example", verdict: "ok", scopeLabel: "personal:U1", tenant: first },
          { host: "second.example", verdict: "denied", scopeLabel: "personal:U1", tenant: second },
        ],
        sink,
        { tenantLookup: tenantLookup(db.app) },
      );
      assert.deepEqual(result.body, { accepted: 2, rejected: 0 });
      await settle(() =>
        db.owner.q("SELECT 1 FROM egress_events WHERE host LIKE '%.example'").then((r) => r.length === 2),
      );
      await assertRowsByTenant(
        db.owner,
        "SELECT tenant_id::text, host FROM egress_events WHERE host LIKE '%.example'",
        [
          [first, "first.example"],
          [second, "second.example"],
        ],
      );
    }));
});
