import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresAppPageViewLog } from "../src/deploy/page-views.ts";
import { inTestTenant, testTenants } from "./support/test-tenants.ts";

const URL = process.env.DATABASE_URL;
const view = () => ({
  deploymentId: "dep-1",
  version: null,
  viewer: null,
  authMode: "public" as const,
  at: 1_700_000_000_002,
  path: "/",
  ip: null,
  userAgent: null,
});
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres page-view tests";

test("pg page-view log stores one row per view with clipped request fields", { skip }, () =>
  inTestTenant(async () => {
    const pg = (await import("pg")).default;
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_OWNER_URL });
    try {
      await admin.query(
        `INSERT INTO deployments (tenant_id, id, owner_scope_id, created_by, current_version, status, versions)
         VALUES ($1, 'dep-1', 'personal:U1', 'U1', 1, 'running', '[]')`,
        [testTenants()[0]],
      );
      const log = createPostgresAppPageViewLog(URL!);
      await log.record({
        deploymentId: "dep-1",
        version: 3,
        viewer: "alice@example.com",
        authMode: "signed_in",
        at: 1_700_000_000_000,
        path: "/reports",
        ip: "203.0.113.7",
        userAgent: "ua".repeat(400),
      });
      await log.record({
        deploymentId: "dep-1",
        version: null,
        viewer: null,
        authMode: "public",
        at: 1_700_000_000_001,
        path: `/${"p".repeat(5000)}`,
        ip: null,
        userAgent: null,
      });
      const { rows } = await admin.query(
        "SELECT deployment_id, version, viewer, auth_mode, at, path, ip, user_agent FROM app_page_views ORDER BY at",
      );
      assert.equal(rows.length, 2);
      assert.deepEqual(
        { ...rows[0], at: Number(rows[0].at), user_agent: rows[0].user_agent.length },
        {
          deployment_id: "dep-1",
          version: 3,
          viewer: "alice@example.com",
          auth_mode: "signed_in",
          at: 1_700_000_000_000,
          path: "/reports",
          ip: "203.0.113.7",
          user_agent: 512,
        },
      );
      assert.equal(rows[1].viewer, null);
      assert.equal(rows[1].auth_mode, "public");
      assert.equal(rows[1].path.length, 2048);
      assert.equal(rows[1].ip, null);
      await assert.rejects(
        log.record({ ...view(), deploymentId: "no-such-app" }),
        (err: { code?: string }) => err.code === "23503",
      );
      await admin.query("DELETE FROM deployments WHERE id = 'dep-1'");
      assert.equal((await admin.query("SELECT 1 FROM app_page_views WHERE deployment_id = 'dep-1'")).rowCount, 0);
    } finally {
      await admin.end();
    }
  }),
);
