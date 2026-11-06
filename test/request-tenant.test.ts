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
import { bindBootTenant, bootTenant, inBootTenant, readBootTenant } from "../src/tenants/boot.ts";
import { boundTenant, withoutTenant, withTenant } from "../src/tenants/context.ts";
import { onTenantLoad } from "../src/tenants/cache.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";
import { ownerUrl, TEST_TENANT } from "./support/test-tenant.ts";

const SECRET = "request-tenant-capability-secret".repeat(2);
const a = randomUUID();
const b = randomUUID();

const claims = () => ({ actorId: "U1", scopeId: "personal:U1" as const, exp: Date.now() + 60_000 });

async function probe(
  route: Pick<Route, "auth" | "tenant"> | undefined,
  bootTenant: string | undefined,
  headers: Record<string, string> = {},
): Promise<{ status: number; tenant: string | null }> {
  const server = createHttpServer((req, res) => {
    void withRequestTenant(
      req,
      res,
      route,
      SECRET,
      bootTenant,
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

test("a capability token binds the tenant it carries, over the boot tenant", () =>
  withoutTenant(async () => {
    const token = await withTenant(a, () => mintCapabilityToken(claims(), SECRET));
    assert.equal((await verifyCapabilityToken(token, SECRET))?.tenant, a);
    assert.deepEqual(await probe({ auth: "either" }, b, { "x-agent-capability": token }), { status: 200, tenant: a });
    assert.deepEqual(
      await probe({ auth: { aud: "x", bearer: true } }, undefined, { authorization: `Bearer ${token}` }),
      {
        status: 200,
        tenant: a,
      },
    );
  }));

test("a token minted unbound carries no tenant and falls back to the boot tenant", () =>
  withoutTenant(async () => {
    const token = await mintCapabilityToken(claims(), SECRET);
    assert.equal((await verifyCapabilityToken(token, SECRET))?.tenant, undefined);
    assert.deepEqual(await probe({ auth: "either" }, b, { "x-agent-capability": token }), { status: 200, tenant: b });
  }));

test("a token with a malformed tenant claim does not verify", () =>
  withoutTenant(async () => {
    const token = await mintCapabilityToken({ ...claims(), tenant: "not-a-uuid" }, SECRET);
    assert.equal(await verifyCapabilityToken(token, SECRET), null);
  }));

test("without a claim or a single boot tenant the request is refused", () =>
  withoutTenant(async () => {
    assert.deepEqual(await probe({ auth: "source" }, undefined), { status: 401, tenant: null });
    assert.deepEqual(await probe(undefined, undefined), { status: 401, tenant: null });
    assert.deepEqual(await probe({ auth: "source" }, b), { status: 200, tenant: b });
  }));

test("routes marked tenant none run unbound", () =>
  withoutTenant(async () => {
    const token = await withTenant(a, () => mintCapabilityToken(claims(), SECRET));
    assert.deepEqual(await probe({ auth: "public", tenant: "none" }, b, { "x-agent-capability": token }), {
      status: 200,
      tenant: null,
    });
    assert.deepEqual(await probe({ auth: "public", tenant: "none" }, undefined), { status: 200, tenant: null });
  }));

test("work started in the boot tenant stays bound across timers", () =>
  withoutTenant(async () => {
    const seen = await inBootTenant(a, () => new Promise((resolve) => setTimeout(() => resolve(boundTenant()), 1)));
    assert.equal(seen, a);
    assert.equal(
      inBootTenant(undefined, () => boundTenant()),
      undefined,
    );
  }));

async function serve(databaseUrl: string): Promise<{ get: (path: string) => Promise<number>; close: () => void }> {
  const built = buildApp(testConfig({ databaseUrl }));
  await bindBootTenant(() => readBootTenant(databaseUrl));
  const server = createInsecureTestServer(built.app);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    get: async (path) => (await fetch(`${base}${path}`)).status,
    close: () => server.close(),
  };
}

test("an install with one tenant serves requests bound to it, and a server started after a second exists refuses them", () =>
  withoutTenant(async () => {
    const databaseUrl = testMigratedDatabaseUrl();
    const db = new pg.Pool({ connectionString: ownerUrl(databaseUrl).toString() });
    await db.query("DELETE FROM tenants WHERE id <> $1", [TEST_TENANT]);
    const single = await serve(databaseUrl);
    try {
      assert.equal(await readBootTenant(databaseUrl), TEST_TENANT);
      assert.notEqual(await single.get("/v1/deliveries"), 401);
      await db.query("INSERT INTO tenants(id) VALUES ($1)", [randomUUID()]);
      assert.equal(await readBootTenant(databaseUrl), undefined);
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
  }));

test("bindBootTenant records the tenant boot read so bootTenant names it afterwards", () =>
  withoutTenant(async () => {
    assert.equal(await bindBootTenant(async () => a), a);
    assert.equal(bootTenant(), a);
    assert.equal(await bindBootTenant(async () => undefined), undefined);
    assert.equal(bootTenant(), undefined);
  }));

test("the bound tenant's settings load before the route runs", () =>
  withoutTenant(async () => {
    const seen: (string | undefined)[] = [];
    const stop = onTenantLoad(async () => void seen.push(`ready:${boundTenant()}`));
    await withRequestTenant(
      { headers: {} } as never,
      {} as never,
      { auth: "source" },
      SECRET,
      b,
      () => void seen.push(`next:${boundTenant()}`),
    ).finally(stop);
    assert.deepEqual(seen, [`ready:${b}`, `next:${b}`]);
  }));
