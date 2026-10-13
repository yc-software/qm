import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;

test("acknowledged audit ingestion survives a process crash", { skip: !databaseUrl, timeout: 20_000 }, async () => {
  const host = `crash-probe-${crypto.randomUUID()}.example`;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const lock = await pool.connect();
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { createInsecureTestServer } from './src/api/server.ts';
    import { createPostgresEgressAuditSink } from './src/admin/postgres-egress-audit-sink.ts';
    await createPostgresEgressAuditSink(process.env.DATABASE_URL).list();
    const sink = createPostgresEgressAuditSink(process.env.DATABASE_URL);
    const server = createInsecureTestServer({}, { egressAudit: sink });
    server.listen(0, '127.0.0.1', () => process.send(server.address().port));
  `,
    ],
    { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr!.on("data", (part) => {
    stderr += part;
  });
  let locked = false;
  try {
    const [port] = await once(child, "message");
    await lock.query("SELECT pg_advisory_lock(hashtext($1))", ["qm:schema-migrations"]);
    locked = true;
    const response = fetch(`http://127.0.0.1:${port}/v1/egress-audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ records: [{ host, verdict: "ok", scopeLabel: "personal:crash-probe" }] }),
    });
    let insertBlocked = false;
    for (let i = 0; i < 100; i++) {
      const r = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND query LIKE 'SELECT pg_try_advisory_lock%'",
      );
      if (r.rowCount) {
        insertBlocked = true;
        break;
      }
      await sleep(10);
    }
    assert.ok(insertBlocked, stderr);
    const early = await Promise.race([response.then(() => true), sleep(100, false)]);
    if (!early) {
      await lock.query("SELECT pg_advisory_unlock_all()");
      locked = false;
    }
    const reply = await response;
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), { accepted: 1, rejected: 0 });
    child.kill("SIGKILL");
    await exited;
    if (locked) {
      await lock.query("SELECT pg_advisory_unlock_all()");
      locked = false;
    }
    const result = await pool.query("SELECT host FROM egress_events WHERE host=$1", [host]);
    console.log(JSON.stringify({ acknowledgedBeforeCommit: early, rowsAfterCrash: result.rowCount }));
    assert.equal(result.rowCount, 1, "a 200 response must represent a committed audit record");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    if (locked) await lock.query("SELECT pg_advisory_unlock_all()");
    await lock.query("DELETE FROM egress_events WHERE host=$1", [host]);
    lock.release();
    await pool.end();
  }
});
