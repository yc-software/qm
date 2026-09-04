#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { readdirSync, renameSync, existsSync, lstatSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const FROM_SLACK = args.includes("--from-slack");
const REWRITE_HISTORY = args.includes("--rewrite-history");
const ALLOW_LIVE = args.includes("--allow-live");
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const MAPPING_FILE = argValue("--mapping");
const DATA_DIR = argValue("--data-dir");

const BATCH_SIZE = 100;

async function buildMappingFromSlack() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("--from-slack requires SLACK_BOT_TOKEN");
  const mapping = {};
  let cursor;
  do {
    const url = new URL("https://slack.com/api/users.list");
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await (await fetch(url, { headers: { authorization: `Bearer ${token}` } })).json();
    if (!res.ok) throw new Error(`users.list failed: ${res.error}`);
    for (const u of res.members ?? []) {
      const email = (u.profile?.email ?? "").trim().toLowerCase();
      if (u.id && email.includes("@") && !u.is_bot && !u.deleted) mapping[u.id] = email;
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return mapping;
}

export function makeRewriter(mapping) {
  const ids = Object.keys(mapping).sort((a, b) => b.length - a.length);
  const patterns = ids.map((id) => ({
    re: new RegExp(`(^|[^A-Za-z0-9])${id}(?=$|[^A-Za-z0-9])`, "g"),
    to: mapping[id],
  }));
  const rewriteString = (s) => {
    let out = s;
    for (const { re, to } of patterns) out = out.replace(re, (_m, pre) => `${pre}${to}`);
    return out;
  };
  const rewriteJson = (v) => {
    if (typeof v === "string") return rewriteString(v);
    if (Array.isArray(v)) return v.map(rewriteJson);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[rewriteString(k)] = rewriteJson(val);
      return out;
    }
    return v;
  };
  return { rewriteString, rewriteJson };
}

export function mergeDirs(src, dst) {
  const conflicts = [];
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dst, entry);
    if (!existsSync(d)) {
      renameSync(s, d);
    } else if (lstatSync(s).isDirectory() && lstatSync(d).isDirectory()) {
      for (const c of mergeDirs(s, d)) conflicts.push(join(entry, c));
    } else {
      conflicts.push(entry);
    }
  }
  if (readdirSync(src).length === 0) rmdirSync(src);
  return conflicts;
}

const LIVE_COLUMNS = [
  ["participants", ["principal_id"]],
  ["sessions", ["scope_id"]],
  ["acl_grants", ["owner_scope_id", "grantee_scope_id", "granted_by"]],
  ["admin_grants", ["principal_id", "scope_id", "granted_by"]],
  ["file_artifacts", ["owner_scope_id", "created_by", "created_in_scope"]],
  ["process_sessions", ["scope_id"]],
  ["directory_members", ["principal_id"]],
  ["directory_channel_members", ["principal_id"]],
];
const HISTORY_COLUMNS = [
  ["session_entries", ["scope_label", "payload"]],
  ["session_llm_requests", ["scope_label", "request"]],
  ["runs", ["request", "result"]],
  ["tool_calls", ["output"]],
  ["turn_metrics", ["scope_label"]],
  ["egress_events", ["scope_label", "principal_id"]],
  ["credential_usage", ["scope_label", "principal_id"]],
  ["error_events", ["scope_label"]],
  ["audit_events", []],
];

export async function runMigration({
  pool,
  mapping,
  apply,
  rewriteHistory = false,
  dataDir,
  allowLive = false,
  log = console.log,
}) {
  const { rewriteString, rewriteJson } = makeRewriter(mapping);
  const problems = [];
  const q = async (text, params) => (await pool.query(text, params)).rows;

  const others = await q(
    `SELECT pid, application_name FROM pg_stat_activity
     WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
  );
  if (others.length) {
    const who = others.map((r) => `pid=${r.pid}${r.application_name ? ` (${r.application_name})` : ""}`).join(", ");
    const msg = `${others.length} other client(s) connected to the database: ${who} — stop the core before --apply`;
    if (apply && !allowLive) throw new Error(`${msg} (or pass --allow-live to proceed anyway)`);
    log(`WARNING: ${msg}`);
  }

  const tableExists = async (t) =>
    (await q(`SELECT 1 FROM information_schema.tables WHERE table_name = $1 AND table_schema = 'public'`, [t])).length >
    0;
  const columnExists = async (t, c) =>
    (
      await q(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 AND table_schema = 'public'`,
        [t, c],
      )
    ).length > 0;

  async function forEachRow(sql, fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DECLARE migrate_cur NO SCROLL CURSOR FOR ${sql}`);
      for (;;) {
        const { rows } = await client.query(`FETCH ${BATCH_SIZE} FROM migrate_cur`);
        if (rows.length === 0) break;
        for (const row of rows) await fn(row, client);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  function reportTable(label, changed, missed) {
    if (changed || missed) log(`  ${label}: ${changed} row(s)${missed ? ` (${missed} missed)` : ""}`);
    if (missed)
      problems.push(
        `${label}: ${missed} row(s) changed under the migration and were not rewritten — stop all writers and re-run`,
      );
  }

  async function rewriteColumns(table, columns) {
    if (!(await tableExists(table))) return;
    for (const col of columns) {
      if (!(await columnExists(table, col))) continue;
      let changed = 0;
      let missed = 0;
      await forEachRow(`SELECT ctid, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`, async (row, client) => {
        const old = String(row.v);
        const next = rewriteString(old);
        if (next === old) return;
        if (!apply) {
          changed++;
          return;
        }
        await client.query("SAVEPOINT row_write");
        try {
          const upd = await client.query(`UPDATE ${table} SET ${col} = $1 WHERE ctid = $2 AND ${col} = $3`, [
            next,
            row.ctid,
            old,
          ]);
          if (upd.rowCount === 1) changed++;
          else missed++;
        } catch (e) {
          await client.query("ROLLBACK TO SAVEPOINT row_write");
          if (e.code !== "23505") throw e;
          const del = await client.query(`DELETE FROM ${table} WHERE ctid = $1 AND ${col} = $2`, [row.ctid, old]);
          if (del.rowCount === 1) changed++;
          else missed++;
        }
        await client.query("RELEASE SAVEPOINT row_write");
      });
      reportTable(`${table}.${col}`, changed, missed);
    }
  }

  async function rewriteKvTables() {
    const kvTables = await q(`
      SELECT c1.table_name FROM information_schema.columns c1
      JOIN information_schema.columns c2 ON c1.table_name = c2.table_name AND c2.column_name = 'json' AND c2.data_type = 'jsonb'
      WHERE c1.column_name = 'id' AND c1.data_type = 'text' AND c1.table_schema = 'public'`);
    for (const { table_name: table } of kvTables) {
      let changed = 0;
      let missed = 0;
      await forEachRow(`SELECT id, json FROM ${table}`, async (row, client) => {
        const newId = rewriteString(row.id);
        const newJson = rewriteJson(row.json);
        const oldJsonText = JSON.stringify(row.json);
        const newJsonText = JSON.stringify(newJson);
        if (newId === row.id && newJsonText === oldJsonText) return;
        if (!apply) {
          changed++;
          return;
        }
        if (newId === row.id) {
          const upd = await client.query(`UPDATE ${table} SET json = $1 WHERE id = $2 AND json = $3::jsonb`, [
            newJsonText,
            row.id,
            oldJsonText,
          ]);
          if (upd.rowCount === 1) changed++;
          else missed++;
          return;
        }
        const ins = await client.query(`INSERT INTO ${table} (id, json) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [
          newId,
          newJsonText,
        ]);
        if (ins.rowCount === 1) {
          const del = await client.query(`DELETE FROM ${table} WHERE id = $1 AND json = $2::jsonb`, [
            row.id,
            oldJsonText,
          ]);
          if (del.rowCount === 1) changed++;
          else missed++;
          return;
        }
        const dupe = await client.query(`SELECT 1 FROM ${table} WHERE id = $1 AND json = $2::jsonb`, [
          newId,
          newJsonText,
        ]);
        if (dupe.rowCount === 1) {
          const del = await client.query(`DELETE FROM ${table} WHERE id = $1 AND json = $2::jsonb`, [
            row.id,
            oldJsonText,
          ]);
          if (del.rowCount === 1) changed++;
          else missed++;
          return;
        }
        problems.push(
          `${table}: "${row.id}" -> "${newId}" — different data already exists under "${newId}"; kept both rows, merge manually and delete the old id`,
        );
      });
      reportTable(`${table} (kv)`, changed, missed);
    }
  }

  log("relational tables:");
  for (const [table, columns] of LIVE_COLUMNS) await rewriteColumns(table, columns);
  if (rewriteHistory) {
    log("history tables:");
    for (const [table, columns] of HISTORY_COLUMNS) await rewriteColumns(table, columns);
  }
  log("durable-map tables:");
  await rewriteKvTables();

  const wsRoot = dataDir ? join(dataDir, "workspaces") : null;
  if (wsRoot && existsSync(wsRoot)) {
    const safeScope = (scopeId) => scopeId.replace(/[^a-zA-Z0-9_.-]/g, "__");
    log("workspace dirs:");
    for (const dir of readdirSync(wsRoot)) {
      for (const id of Object.keys(mapping)) {
        if (dir !== safeScope(`personal:${id}`)) continue;
        const next = safeScope(`personal:${mapping[id]}`);
        const from = join(wsRoot, dir);
        const to = join(wsRoot, next);
        if (!apply) {
          log(`  ${dir} -> ${next}`);
          continue;
        }
        if (!existsSync(to)) {
          renameSync(from, to);
          log(`  ${dir} -> ${next}`);
          continue;
        }
        const conflicts = mergeDirs(from, to);
        log(`  ${dir} -> ${next} (merged into existing dir)`);
        if (conflicts.length) {
          problems.push(
            `workspace dir ${dir}: ${conflicts.length} entr${conflicts.length === 1 ? "y" : "ies"} already exist under ${next} and were kept in place — reconcile manually: ${conflicts.join(", ")}`,
          );
        }
      }
    }
  }

  if (problems.length) {
    log(`${problems.length} problem(s) need manual attention:`);
    for (const p of problems) log(`  - ${p}`);
  }
  return { problems };
}

async function main() {
  const mapping = FROM_SLACK ? await buildMappingFromSlack() : JSON.parse(readFileSync(MAPPING_FILE ?? "", "utf8"));
  const n = Object.keys(mapping).length;
  if (!n) throw new Error("mapping is empty");
  console.log(`${APPLY ? "APPLY" : "DRY RUN"}: ${n} principal id(s) to re-key`);
  if (FROM_SLACK) console.log(JSON.stringify(mapping, null, 2));

  const pg = await import("pg")
    .then((m) => m.default)
    .catch(async () => {
      const { createRequire } = await import("node:module");
      return createRequire(join(process.cwd(), "package.json"))("pg");
    });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let problems;
  try {
    ({ problems } = await runMigration({
      pool,
      mapping,
      apply: APPLY,
      rewriteHistory: REWRITE_HISTORY,
      dataDir: DATA_DIR,
      allowLive: ALLOW_LIVE,
    }));
  } finally {
    await pool.end();
  }
  if (problems.length) process.exitCode = 1;
  console.log(APPLY ? "done" : "dry run complete — re-run with --apply to write");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
