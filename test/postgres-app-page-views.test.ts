import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresAppPageViewLog } from "../src/deploy/page-views.ts";

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

test("pg page-view log stores one row per view with clipped request fields", { skip }, async () => {
  const pg = (await import("pg")).default;
  const admin = new pg.Pool({ connectionString: URL });
  try {
    await admin.query("DROP TABLE IF EXISTS app_page_views CASCADE");
    await admin.query("DELETE FROM qm_schema_migrations WHERE id LIKE 'deploy/app-page-views/%'").catch(() => {});
    await admin.query("CREATE TABLE IF NOT EXISTS deployments (id TEXT PRIMARY KEY, json JSONB NOT NULL)");
    await admin.query(`INSERT INTO deployments (id, json) VALUES ('dep-1', '{}') ON CONFLICT (id) DO NOTHING`);
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
    await assert.rejects(
      admin.query("DELETE FROM deployments WHERE id = 'dep-1'"),
      (err: { code?: string }) => err.code === "23503",
    );
  } finally {
    await admin.query("DROP TABLE IF EXISTS app_page_views CASCADE").catch(() => {});
    await admin.query("DELETE FROM deployments WHERE id = 'dep-1'").catch(() => {});
    await admin.end();
  }
});
