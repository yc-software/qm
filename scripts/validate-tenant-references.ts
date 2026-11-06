import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { pgConnectionOptions, resolvePgCaTrust } from "../src/persistence/pg-pool.ts";

const { values } = parseArgs({
  options: {
    "pause-ms": { type: "string", default: "1000" },
    "lock-timeout-ms": { type: "string", default: "5000" },
    "dry-run": { type: "boolean", default: false },
  },
});

const pauseMs = Number(values["pause-ms"]);
const lockTimeoutMs = Number(values["lock-timeout-ms"]);
if (!Number.isInteger(pauseMs) || pauseMs < 0) throw new Error("--pause-ms must be a non-negative integer");
if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1) throw new Error("--lock-timeout-ms must be positive");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL to the database whose tenant references should be validated");

const ca = resolvePgCaTrust({ cert: process.env.DATABASE_CA_CERT, certFile: process.env.DATABASE_CA_CERT_FILE }).ssl
  ?.ca;
const client = new pg.Client({
  ...pgConnectionOptions(databaseUrl, ca),
  application_name: "validate-tenant-references",
});

interface Pending {
  owner: string;
  name: string;
  bytes: string;
}

const PENDING = `SELECT format('%I.%I', n.nspname, t.relname) AS owner, c.conname AS name,
       pg_total_relation_size(t.oid)::text AS bytes
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE c.contype = 'f' AND NOT c.convalidated AND c.conname LIKE '%\\_tenant'
   AND n.nspname = current_schema()
 ORDER BY pg_total_relation_size(t.oid), t.relname, c.conname`;

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
  log("stopping", { reason: "SIGINT; the current constraint finishes or rolls back on its own" });
});

await client.connect();
try {
  await client.query("SET statement_timeout = 0");
  await client.query(`SET lock_timeout = ${lockTimeoutMs}`);
  const pending = (await client.query<Pending>(PENDING)).rows;
  log("pending", { count: pending.length });
  let done = 0;
  for (const { owner, name, bytes } of pending) {
    if (stopping) break;
    if (values["dry-run"]) {
      log("would-validate", { table: owner, constraint: name, bytes: Number(bytes) });
      continue;
    }
    const started = Date.now();
    log("validating", { table: owner, constraint: name, bytes: Number(bytes), done, total: pending.length });
    await client.query(`ALTER TABLE ${owner} VALIDATE CONSTRAINT ${pg.escapeIdentifier(name)}`);
    done++;
    log("validated", { table: owner, constraint: name, ms: Date.now() - started, done, total: pending.length });
    if (pauseMs) await sleep(pauseMs);
  }
  const left = (await client.query<Pending>(PENDING)).rows.length;
  log("finished", { validated: done, remaining: left });
  process.exitCode = left === 0 || values["dry-run"] ? 0 : 1;
} finally {
  await client.end();
}
