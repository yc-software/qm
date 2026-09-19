import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { buildEgressAuthzRequestListener, buildPooledEgressAuthzRequestListener } from "../src/egress-authz-main.ts";
import { mintCapabilityToken, routingTokenTenant } from "../src/auth/capability-token.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { createTenantContext, currentTenant, runWithTenant, type TenantContext } from "../src/tenancy/context.ts";
import type { EgressAuditRecord } from "../src/admin/egress-audit-sink.ts";
import { createPostgresEgressAuditSink } from "../src/admin/postgres-egress-audit-sink.ts";
import { configurePgPooling } from "../src/persistence/pg-pool.ts";

const SECRET = "shared-egress-capability-secret-for-tenant-tests";
const contexts = ["alpha", "beta"].map((id) => createTenantContext({ id, env: {}, pooled: true }));
const lookup = async () => ["93.184.216.34"];

async function serve(t: TestContext, listener: RequestListener): Promise<string> {
  const server: Server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function token(context: TenantContext): Promise<string> {
  return runWithTenant(context, () =>
    mintCapabilityToken(
      {
        actorId: "U1",
        scopeId: "personal:U1",
        aud: "egress-proxy",
        exp: Date.now() + 60_000,
        egress: { allowedHosts: [] },
      },
      SECRET,
    ),
  );
}

async function check(base: string, host: string, credential?: string, tenantId?: string): Promise<number> {
  const response = await fetch(base, {
    headers: {
      "x-egress-authority": `${host}:443`,
      ...(credential ? { "proxy-authorization": `Bearer ${credential}` } : {}),
      ...(tenantId ? { "x-qm-tenant": tenantId } : {}),
    },
  });
  await response.arrayBuffer();
  return response.status;
}

test("pooled egress routes authenticated tokens into their tenant audit sink", async (t) => {
  const records = new Map<string, Array<Omit<EgressAuditRecord, "ts">>>();
  const listener = buildPooledEgressAuthzRequestListener(
    contexts.map((context) => {
      const rows: Array<Omit<EgressAuditRecord, "ts">> = [];
      records.set(context.id, rows);
      return {
        context,
        deps: {
          capabilitySecret: SECRET,
          lookup,
          audit: {
            record(row: Omit<EgressAuditRecord, "ts">) {
              assert.equal(currentTenant()?.id, context.id);
              rows.push(row);
            },
          },
        },
      };
    }),
  );
  const base = await serve(t, listener);
  const [alpha, beta] = await Promise.all(contexts.map(token));
  const valid = await Promise.all([check(base, "alpha.example", alpha), check(base, "beta.example", beta)]);
  assert.deepEqual(valid, [200, 200]);
  assert.deepEqual(
    records.get("alpha")?.map((row) => row.host),
    ["alpha.example"],
  );
  assert.deepEqual(
    records.get("beta")?.map((row) => row.host),
    ["beta.example"],
  );
  assert.equal(await check(base, "foreign.example", alpha, "beta"), 403);
  assert.equal(await check(base, "unknown.example", undefined, "alpha"), 403);
  assert.equal(await check(base, "unknown.example", await mintSignedPayload({ orgId: "unknown" }, SECRET)), 403);
  assert.equal(records.get("alpha")?.length, 1);
  assert.equal(records.get("beta")?.length, 1);
  const pieces = alpha!.split(".");
  pieces[1] = Buffer.from(JSON.stringify({ orgId: "beta" })).toString("base64url");
  assert.equal(await check(base, "tampered.example", pieces.join(".")), 403);
  const denied = records.get("beta")?.at(-1);
  assert.equal(denied?.allowed, false);
  assert.equal(denied?.principalId, "unknown");
});

test("a shared egress signing key never permits a foreign or unbound tenant claim", async (t) => {
  const base = await serve(
    t,
    buildEgressAuthzRequestListener({
      tenantId: "beta",
      requireTenantBinding: true,
      capabilitySecret: SECRET,
      lookup,
      audit: { record() {} },
    }),
  );
  assert.equal(await check(base, "example.com", await token(contexts[0]!)), 403);
  assert.equal(await check(base, "example.com", await token(contexts[1]!)), 200);
  const unbound = await mintSignedPayload(
    { actorId: "U1", scopeId: "personal:U1", aud: "egress-proxy", exp: Date.now() + 60_000 },
    SECRET,
  );
  assert.equal(await check(base, "example.com", unbound), 403);
  assert.equal(await check(base, "example.com"), 403);
  assert.throws(
    () =>
      buildEgressAuthzRequestListener({
        tenantId: "beta",
        requireTenantBinding: true,
        capabilitySecret: SECRET,
        tokenless: "open",
        audit: { record() {} },
      }),
    /token-only access/,
  );
});

test("token routing hints reject malformed payloads and do not authenticate their signature", async () => {
  const bound = await token(contexts[0]!);
  assert.equal(routingTokenTenant(bound), "alpha");
  assert.equal(
    routingTokenTenant(`${Buffer.from(JSON.stringify({ orgId: "alpha" })).toString("base64url")}.fake`),
    "alpha",
  );
  for (const invalid of [null, "", "no-token", "....", "a".repeat(16_385)])
    assert.equal(routingTokenTenant(invalid), null);
  for (const orgId of [undefined, "", 1, "tenant\nalpha", "a".repeat(129)]) {
    assert.equal(routingTokenTenant(await mintSignedPayload({ orgId }, SECRET)), null);
  }
});

test(
  "pooled egress writes durable isolated Postgres audit rows for identical principal and scope IDs",
  {
    skip: !process.env.DATABASE_URL,
  },
  async (t) => {
    const pg = (await import("pg")).default;
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const databases: string[] = [];
    const sinks: ReturnType<typeof createPostgresEgressAuditSink>[] = [];
    try {
      const tenants = [];
      for (const context of contexts) {
        const name = `qm_tenant_egress_${context.id}_${suffix}`;
        await admin.query(`CREATE DATABASE "${name}"`);
        databases.push(name);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${name}`;
        const tenant = createTenantContext({ id: context.id, env: { DATABASE_URL: url.toString() }, pooled: true });
        const audit = runWithTenant(tenant, () => {
          configurePgPooling({ databaseUrl: url.toString(), queryMax: 1, sessionMax: 1 });
          return createPostgresEgressAuditSink(url.toString());
        });
        sinks.push(audit);
        tenants.push({ context: tenant, deps: { capabilitySecret: SECRET, audit, lookup } });
      }
      const base = await serve(t, buildPooledEgressAuthzRequestListener(tenants));
      await Promise.all(
        tenants.map(async ({ context }) => {
          assert.equal(await check(base, `${context.id}.example`, await token(context)), 200);
        }),
      );
      for (const { context, deps } of tenants) {
        const rows = await deps.audit.list();
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.host, `${context.id}.example`);
        assert.equal(rows[0]?.principalId, "U1");
        assert.equal(rows[0]?.scopeLabel, "personal:U1");
        await deps.audit.close();
        const reopened = runWithTenant(context, () => createPostgresEgressAuditSink(context.env.DATABASE_URL!));
        try {
          assert.deepEqual(await reopened.list(), rows);
        } finally {
          await reopened.close();
        }
      }
    } finally {
      await Promise.all(sinks.map((sink) => sink.close()));
      for (const name of databases) await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  },
);
