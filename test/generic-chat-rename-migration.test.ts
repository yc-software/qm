import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import { GENERIC_CHAT_RENAME } from "../src/surfaces/generic-chat/migration.ts";
import { tenantLookup } from "../src/tenants/lookup.ts";
import { TEST_TENANT, boundUrl, seedTestTenant } from "./support/test-tenant.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "set DATABASE_URL (a Postgres) to run the generic chat rename migration test";
const exec = promisify(execFile);

const migrate = (url: string) =>
  exec(process.execPath, ["src/migrate-main.ts"], {
    cwd: new URL("..", import.meta.url),
    timeout: 120_000,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      DATABASE_URL: url,
      SANDBOX_BACKEND: "local",
      ORG_ID: "o",
      CONNECTOR_SECRET_KEY: "test-connector-secret-0123456789abcdef",
    },
  });

test("rewrites rows stored under the partner-chat surface id to generic-chat", { skip }, async () => {
  const parent = new pg.Pool({ connectionString: databaseUrl });
  const name = `generic_chat_${randomUUID().replaceAll("-", "")}`;
  await parent.query(`CREATE DATABASE ${name}`);
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  await seedTestTenant(url.toString());
  const db = new pg.Pool({ connectionString: boundUrl(url.toString()) });
  try {
    await migrate(url.toString());
    const ref = "partner-chat:596:group:302069";
    await db.query(`UPDATE tenants SET settings = '{"partnerChatAccount": "596"}' WHERE id = $1`, [TEST_TENANT]);
    await db.query(
      `INSERT INTO sessions (id, type, scope_id, thread_ref, created_at, surface) VALUES ('s1', 'group', $1, $2, 1, 'partner-chat')`,
      [`group:${ref}`, `${ref}:3497027`],
    );
    await db.query(
      `INSERT INTO deliveries (id, idempotency_key, destination, text, created_at)
       VALUES ('d1', $1, $2, 'hi', 1)`,
      [`post:r1:partner-chat:${ref}:0`, { type: "partner-chat", target: ref, audienceScopeId: `group:${ref}` }],
    );
    await db.query(`INSERT INTO directory_groups (org_id, group_id, surface) VALUES ('o', $1, 'partner-chat')`, [ref]);
    await db.query(`DELETE FROM qm_schema_migrations WHERE id = $1`, [GENERIC_CHAT_RENAME.id]);
    await migrate(url.toString());

    const renamed = "generic-chat:596:group:302069";
    const [session] = (await db.query(`SELECT scope_id, thread_ref, surface FROM sessions`)).rows;
    assert.deepEqual(session, {
      scope_id: `group:${renamed}`,
      thread_ref: `${renamed}:3497027`,
      surface: "generic-chat",
    });
    const [delivery] = (await db.query(`SELECT idempotency_key, destination FROM deliveries`)).rows;
    assert.deepEqual(delivery, {
      idempotency_key: `post:r1:generic-chat:${renamed}:0`,
      destination: { type: "generic-chat", target: renamed, audienceScopeId: `group:${renamed}` },
    });
    assert.deepEqual((await db.query(`SELECT group_id, surface FROM directory_groups`)).rows, [
      { group_id: renamed, surface: "generic-chat" },
    ]);
    const q = async (text: string, params?: unknown[]) => (await db.query(text, params)).rows;
    assert.equal(await tenantLookup({ q }).tenantFor("generic_chat", "596"), TEST_TENANT);
  } finally {
    await db.end();
    await parent.query(`DROP DATABASE ${name}`);
    await parent.end();
  }
});
