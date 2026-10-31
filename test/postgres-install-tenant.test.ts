import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { ensureInstallTenant, UnknownTenant } from "../src/tenants/install.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { prepareDevTenant } from "../scripts/dev/supervisor/durability.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the install tenant test";

test(
  "a fresh install creates the named tenant once, and a populated one only finds existing slugs",
  { skip },
  async () => {
    const schema = `install_${randomUUID().replaceAll("-", "")}`;
    const url = new globalThis.URL(URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const admin = new pg.Pool({ connectionString: url.toString() });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.tenants(
    id UUID PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
    try {
      const results = await Promise.all(Array.from({ length: 6 }, () => ensureInstallTenant(url.toString(), "acme")));
      assert.equal(new Set(results.map((result) => result.tenant)).size, 1);
      assert.equal(results.filter((result) => result.created).length, 1);
      assert.deepEqual(await ensureInstallTenant(url.toString(), "acme"), {
        tenant: results[0]!.tenant,
        created: false,
      });
      const other = randomUUID();
      await admin.query(`INSERT INTO ${schema}.tenants(id, slug, name) VALUES ($1, 'other', 'Other')`, [other]);
      assert.deepEqual(await ensureInstallTenant(url.toString(), "other"), { tenant: other, created: false });
      await assert.rejects(ensureInstallTenant(url.toString(), "main"), (error: unknown) => {
        assert.ok(error instanceof UnknownTenant);
        assert.equal(error.message, "No tenant has the slug main; this database has acme, other");
        return true;
      });
      const { rows } = await admin.query(`SELECT slug FROM ${schema}.tenants ORDER BY slug`);
      assert.deepEqual(rows, [{ slug: "acme" }, { slug: "other" }]);
    } finally {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test("a dev instance writes its settings to the main tenant beside an older one, or stops", { skip }, async () => {
  const schema = `install_${randomUUID().replaceAll("-", "")}`;
  const url = new globalThis.URL(URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const admin = new pg.Pool({ connectionString: url.toString() });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(
    `CREATE TABLE ${schema}.tenants(
        id UUID PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
  );
  const carried = randomUUID();
  await admin.query(
    `INSERT INTO ${schema}.tenants(id, slug, name, created_at) VALUES ($1, 'main', 'Main', now()), ($2, 'other', 'Other', now() - interval '1 day')`,
    [carried, randomUUID()],
  );
  try {
    assert.deepEqual(await ensureInstallTenant(url.toString(), "main"), { tenant: carried, created: false });
    const requests: { path?: string; authorization?: string; body: string }[] = [];
    let status = 200;
    const core = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({ path: req.url, authorization: req.headers.authorization, body });
        res.writeHead(status).end("{}");
      });
    });
    await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
    const inputs = {
      databaseUrl: url.toString(),
      adminGrantsSeed: "dev@example.com:org_admin",
      baseEnv: {
        CORE_SIGNING_SECRET: "s".repeat(64),
        DEPLOYMENT_CONTROL_SECRET: "c".repeat(64),
        ANTHROPIC_API_KEY: "sk-dev",
        PI_MODEL: "",
        LOOPS_USERS: "dev@example.com",
        PORT: "8080",
      },
      ports: { core: (core.address() as AddressInfo).port },
    };
    const phases: string[] = [];
    const record = (name: string, state: string, detail?: string) => phases.push(`${name} ${state} ${detail ?? ""}`);
    try {
      await prepareDevTenant(inputs, record);
      status = 404;
      await assert.rejects(prepareDevTenant(inputs, record), /this core has no PUT \/v1\/tenant-settings route/);
    } finally {
      await new Promise<void>((resolve) => core.close(() => resolve()));
    }
    assert.deepEqual(phases, [
      "tenant start ",
      `tenant ok using install tenant ${carried}`,
      "tenant ok wrote ADMIN_GRANTS, ANTHROPIC_API_KEY, LOOPS_USERS, WEB_UI_PRINCIPALS, WEB_UI_VOICE_USERS to the install tenant",
      "tenant start ",
      `tenant ok using install tenant ${carried}`,
    ]);
    assert.equal(requests[0]!.path, "/v1/tenant-settings");
    assert.equal(requests[0]!.authorization, `Bearer ${"c".repeat(64)}`);
    assert.deepEqual(JSON.parse(requests[0]!.body), {
      tenant: "main",
      env: {
        ANTHROPIC_API_KEY: "sk-dev",
        LOOPS_USERS: "dev@example.com",
        ADMIN_GRANTS: "dev@example.com:org_admin",
        WEB_UI_PRINCIPALS: "",
        WEB_UI_VOICE_USERS: "",
      },
    });
    const { rows } = await admin.query(`SELECT slug FROM ${schema}.tenants ORDER BY slug`);
    assert.deepEqual(rows, [{ slug: "main" }, { slug: "other" }]);
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
