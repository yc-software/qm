import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { createPostgresBrokerSessions } from "../src/auth/broker-sessions.ts";

const url = process.env.DATABASE_URL;

test(
  "broker sessions persist across instances, expire strictly, and revoke every remembered browser",
  { skip: !url },
  async () => {
    const a = createPostgresBrokerSessions(url!);
    const b = createPostgresBrokerSessions(url!);
    const pool = new pg.Pool({ connectionString: url });
    const email = `${randomUUID()}@example.com`;
    try {
      const first = await a.create(email, 30 * 86400, 90 * 86400);
      const second = await b.create(email, 30 * 86400, 90 * 86400);
      assert.equal((await b.use(first.token))?.authTime, first.authTime);
      const hash = createHash("sha256").update(first.token).digest("hex");
      const rows = await pool.query("SELECT token_hash FROM auth_broker_sessions WHERE email = $1", [email]);
      assert.equal(rows.rows.length, 2);
      assert.ok(rows.rows.some((row) => row.token_hash === hash));
      assert.ok(rows.rows.every((row) => row.token_hash !== first.token));
      await pool.query("UPDATE auth_broker_sessions SET expires_at = now() + interval '1 day' WHERE token_hash = $1", [
        hash,
      ]);
      assert.ok((await b.use(first.token))!.expiresAtMs > Date.now() + 29 * 86400000);
      await pool.query(
        "UPDATE auth_broker_sessions SET absolute_expires_at = now() + interval '1 hour' WHERE token_hash = $1",
        [hash],
      );
      const capped = await b.use(first.token);
      assert.ok(capped!.expiresAtMs <= Date.now() + 3600000);
      await pool.query(
        "UPDATE auth_broker_sessions SET absolute_expires_at = now() - interval '1 second' WHERE token_hash = $1",
        [hash],
      );
      assert.equal(await a.use(first.token), null);
      await pool.query("UPDATE auth_broker_sessions SET expires_at = now() - interval '1 second' WHERE email = $1", [
        email,
      ]);
      assert.equal(await a.use(second.token), null);
      const third = await a.create(email, 30, 90);
      const fourth = await b.create(email, 30, 90);
      await a.revoke(email);
      assert.equal(await a.use(third.token), null);
      assert.equal(await b.use(fourth.token), null);
    } finally {
      await a.revoke(email);
      await pool.end();
    }
  },
);
