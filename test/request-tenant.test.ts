import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { mintCapabilityToken, verifyCapabilityToken } from "../src/auth/capability-token.ts";
import { withRequestTenant } from "../src/api/request-tenant.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import type { Route } from "../src/api/routes/route.ts";
import { bindBootTenant, bootTenant, inBootTenant } from "../src/tenants/boot.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";

const SECRET = "request-tenant-capability-secret".repeat(2);
const a = randomUUID();
const b = randomUUID();

const claims = () => ({ actorId: "U1", scopeId: "personal:U1" as const, exp: Date.now() + 60_000 });

async function probe(
  route: Pick<Route, "auth" | "tenant"> | undefined,
  readBootTenant: string | undefined,
  headers: Record<string, string> = {},
): Promise<{ status: number; tenant: string | null }> {
  const server = createHttpServer((req, res) => {
    void withRequestTenant(
      req,
      res,
      route,
      SECRET,
      async () => readBootTenant,
      () => void res.end(JSON.stringify({ tenant: boundTenant() ?? null })),
    );
  });
  server.listen(0);
  try {
    const response = await fetch(`http://localhost:${(server.address() as AddressInfo).port}/`, { headers });
    const body = (await response.json()) as { tenant?: string | null };
    return { status: response.status, tenant: body.tenant ?? null };
  } finally {
    server.close();
  }
}

test("a capability token binds the tenant it carries, over the boot tenant", async () => {
  const token = await withTenant(a, () => mintCapabilityToken(claims(), SECRET));
  assert.equal((await verifyCapabilityToken(token, SECRET))?.tenant, a);
  assert.deepEqual(await probe({ auth: "either" }, b, { "x-agent-capability": token }), { status: 200, tenant: a });
  assert.deepEqual(await probe({ auth: { aud: "x", bearer: true } }, undefined, { authorization: `Bearer ${token}` }), {
    status: 200,
    tenant: a,
  });
});

test("a token minted unbound carries no tenant and falls back to the boot tenant", async () => {
  const token = await mintCapabilityToken(claims(), SECRET);
  assert.equal((await verifyCapabilityToken(token, SECRET))?.tenant, undefined);
  assert.deepEqual(await probe({ auth: "either" }, b, { "x-agent-capability": token }), { status: 200, tenant: b });
});

test("a token with a malformed tenant claim does not verify", async () => {
  const token = await mintCapabilityToken({ ...claims(), tenant: "not-a-uuid" }, SECRET);
  assert.equal(await verifyCapabilityToken(token, SECRET), null);
});

test("without a claim or a single boot tenant the request is refused", async () => {
  assert.deepEqual(await probe({ auth: "source" }, undefined), { status: 401, tenant: null });
  assert.deepEqual(await probe(undefined, undefined), { status: 401, tenant: null });
  assert.deepEqual(await probe({ auth: "source" }, b), { status: 200, tenant: b });
});

test("routes marked tenant none run unbound", async () => {
  const token = await withTenant(a, () => mintCapabilityToken(claims(), SECRET));
  assert.deepEqual(await probe({ auth: "public", tenant: "none" }, b, { "x-agent-capability": token }), {
    status: 200,
    tenant: null,
  });
  assert.deepEqual(await probe({ auth: "public", tenant: "none" }, undefined), { status: 200, tenant: null });
});

test("work started in the boot tenant stays bound across timers", async () => {
  const seen = await inBootTenant(a, () => new Promise((resolve) => setTimeout(() => resolve(boundTenant()), 1)));
  assert.equal(seen, a);
  assert.equal(
    inBootTenant(undefined, () => boundTenant()),
    undefined,
  );
});

async function serve(databaseUrl: string): Promise<{ get: (path: string) => Promise<number>; close: () => void }> {
  const built = buildApp(testConfig({ databaseUrl }));
  const server = createInsecureTestServer(built.app);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    get: async (path) => (await fetch(`${base}${path}`)).status,
    close: () => server.close(),
  };
}

test("an install with one tenant serves requests bound to it and refuses them once a second exists", async () => {
  const databaseUrl = testMigratedDatabaseUrl();
  const single = await serve(databaseUrl);
  const db = new pg.Pool({ connectionString: databaseUrl });
  try {
    const rows = (await db.query("SELECT id::text AS id FROM tenants")).rows as { id: string }[];
    assert.equal(rows.length, 1);
    assert.equal(await buildApp(testConfig({ databaseUrl })).app.readBootTenant(), rows[0]!.id);
    assert.notEqual(await single.get("/v1/deliveries"), 401);
    await db.query("INSERT INTO tenants(id) VALUES ($1)", [randomUUID()]);
    const multi = await serve(databaseUrl);
    try {
      assert.equal(await multi.get("/v1/deliveries"), 401);
      assert.equal(await multi.get("/healthz"), 200);
      assert.equal(await multi.get("/readyz"), 200);
    } finally {
      multi.close();
    }
  } finally {
    single.close();
    await db.end();
  }
});

test("bindBootTenant records the tenant boot read so bootTenant names it afterwards", async () => {
  assert.equal(await bindBootTenant(async () => a), a);
  assert.equal(bootTenant(), a);
  assert.equal(await bindBootTenant(async () => undefined), undefined);
  assert.equal(bootTenant(), undefined);
});

test("a ready hook runs inside the bound tenant before the route", async () => {
  const seen: (string | undefined)[] = [];
  await withRequestTenant(
    { headers: {} } as never,
    {} as never,
    { auth: "source" },
    SECRET,
    async () => b,
    () => void seen.push(`next:${boundTenant()}`),
    async () => void seen.push(`ready:${boundTenant()}`),
  );
  assert.deepEqual(seen, [`ready:${b}`, `next:${b}`]);
});
