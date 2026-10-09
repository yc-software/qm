import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { handleOf, isPrincipalId, PRINCIPAL_SCHEMA } from "./principals.ts";
import { PRINCIPAL_REFS } from "./principal-refs.ts";

/** Deactivation is a principal property: its durable map is rekeyed by principal UUID like every other id. */
const DEACTIVATIONS = "deactivated_principals";
/** External members are email identities: their map stays keyed by the lowercased address. */
const EMAIL_KEYED = "external_members";

/**
 * One-time conversion from handle-keyed rows to principal UUIDs.
 *
 * Groups every principal id the database mentions (joined by `principal_links` and by Slack directory rows), gives
 * each group a principal, writes its identities, rewrites every registered column and durable-map row to the UUID,
 * merges notebooks, then drops `principal_links`. Dry-run by default; `apply` runs it in one transaction after
 * copying each touched table to `identity_premigration_<table>`.
 */

interface MigrationReport {
  principals: number;
  identities: number;
  rewrites: Record<string, number>;
  notebooksMerged: number;
}

const fold = (id: string): string => {
  const s = id.trim();
  return s.includes("@") ? s.toLowerCase() : s;
};

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function tokenRewriter(mapping: ReadonlyMap<string, string>, prefix = ""): (s: string) => string {
  const ids = [...mapping.keys()].sort((a, b) => b.length - a.length);
  if (!ids.length) return (s) => s;
  const lead = prefix ? escape(prefix) : "(?<![A-Za-z0-9_@.+-])";
  const re = new RegExp(`${lead}(${ids.map(escape).join("|")})(?![A-Za-z0-9_@+-]|\\.[A-Za-z0-9])`, "gi");
  return (s) => s.replace(re, (m, id: string) => `${prefix}${mapping.get(fold(id)) ?? m.slice(prefix.length)}`);
}

/**
 * JSON values are rewritten only when the whole string is a handle or holds a `personal:<handle>` scope, so prose
 * (cron prompts, titles) that merely mentions an address is left alone. Keys are structural and use token rewrite.
 */
function rewriteJson(v: unknown, rw: Rewriters): unknown {
  if (typeof v === "string") return rw.exact(v) ?? rw.personal(v);
  if (Array.isArray(v)) return v.map((x) => rewriteJson(x, rw));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [rw.token(k), rewriteJson(x, rw)]));
  return v;
}

interface Rewriters {
  exact(s: string): string | undefined;
  personal(s: string): string;
  token(s: string): string;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    const p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a: string, b: string): void {
    this.parent.set(this.find(a), this.find(b));
  }
  keys(): string[] {
    return [...this.parent.keys()];
  }
}

async function columnsByTable(client: PoolClient): Promise<Map<string, Set<string>>> {
  const { rows } = await client.query<{ t: string; c: string }>(
    "SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = current_schema()",
  );
  const out = new Map<string, Set<string>>();
  for (const r of rows) out.set(r.t, (out.get(r.t) ?? new Set()).add(r.c));
  return out;
}

const PERSONAL = /^personal:(.+)$/;

export async function runIdentityMigration(opts: {
  pool: Pool;
  apply: boolean;
  log?: (line: string) => void;
}): Promise<MigrationReport> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const client = await opts.pool.connect();
  const report: MigrationReport = { principals: 0, identities: 0, rewrites: {}, notebooksMerged: 0 };
  try {
    await client.query("BEGIN");
    const columns = await columnsByTable(client);
    const has = (t: string, c: string): boolean => columns.get(t)?.has(c) ?? false;
    const uf = new UnionFind();
    const names = new Map<string, string>();
    const slackEmail = new Map<string, string>();
    const see = (raw: unknown): void => {
      if (typeof raw !== "string" || !raw.trim() || isPrincipalId(raw.trim())) return;
      uf.find(fold(raw));
    };

    for (const r of PRINCIPAL_REFS) {
      if (r.kind === "text" || r.kind === "json" || !has(r.table, r.column)) continue;
      const { rows } = await client.query<{ v: string }>(
        `SELECT DISTINCT ${quote(r.column)}::text AS v FROM ${quote(r.table)} WHERE ${quote(r.column)} IS NOT NULL`,
      );
      for (const { v } of rows) {
        if (r.kind === "id") see(v);
        else see(PERSONAL.exec(v)?.[1]);
      }
    }
    if (has("principal_links", "json")) {
      const { rows } = await client.query<{ json: { principalId?: string; canonicalId?: string } }>(
        "SELECT json FROM principal_links",
      );
      for (const { json } of rows)
        if (json.principalId && json.canonicalId) uf.union(fold(json.principalId), fold(json.canonicalId));
    }
    if (has("directory_members", "slack_id")) {
      const { rows } = await client.query<{ p: string; s: string | null; n: string | null }>(
        "SELECT principal_id AS p, slack_id AS s, display_name AS n FROM directory_members",
      );
      for (const { p, s, n } of rows) {
        if (isPrincipalId(p)) continue;
        if (n) names.set(fold(p), n);
        if (s && s !== p) {
          uf.union(s, fold(p));
          if (p.includes("@")) slackEmail.set(s, fold(p));
        }
      }
    }

    if (has(DEACTIVATIONS, "id")) {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM ${DEACTIVATIONS}`);
      for (const { id } of rows) see(id);
    }

    const groups = new Map<string, string[]>();
    for (const id of uf.keys()) {
      const root = uf.find(id);
      groups.set(root, [...(groups.get(root) ?? []), id]);
    }
    const mapping = new Map<string, string>();
    const now = new Date();
    for (const members of groups.values()) {
      const principalId = randomUUID();
      const displayName =
        members.map((m) => names.get(m)).find(Boolean) ?? members.find((m) => m.includes("@")) ?? members[0]!;
      for (const m of members) mapping.set(m, principalId);
      report.principals++;
      if (!opts.apply) continue;
      await client.query(
        "INSERT INTO principals(principal_id, kind, display_name, created_at) VALUES ($1, 'person', $2, $3)",
        [principalId, displayName, now],
      );
      for (const m of members) {
        const h = handleOf(m);
        await client.query(
          `INSERT INTO identities(provider, external_id, principal_id, email, linked_by, evidence, updated_at)
           VALUES ($1, $2, $3, $4, 'platform:migration', $5, $6) ON CONFLICT DO NOTHING`,
          [
            h.provider,
            h.externalId,
            principalId,
            h.provider === "email" ? h.externalId : (slackEmail.get(m) ?? null),
            "pre-identity data",
            now,
          ],
        );
        report.identities++;
      }
    }
    if (!opts.apply) report.identities = mapping.size;
    log(`${opts.apply ? "APPLY" : "DRY RUN"}: ${report.principals} principal(s) from ${mapping.size} handle(s)`);

    const rw = tokenRewriter(mapping);
    const rws: Rewriters = {
      exact: (v) => mapping.get(fold(v)),
      personal: tokenRewriter(mapping, "personal:"),
      token: rw,
    };
    const mapId = (v: string): string => mapping.get(fold(v)) ?? v;
    const mapScope = (v: string): string => {
      const m = PERSONAL.exec(v);
      return m ? `personal:${mapId(m[1]!)}` : v;
    };
    const backedUp = new Set<string>();
    const backup = async (table: string): Promise<void> => {
      if (!opts.apply || backedUp.has(table)) return;
      backedUp.add(table);
      await client.query(`DROP TABLE IF EXISTS ${quote(`identity_premigration_${table}`)}`);
      await client.query(`CREATE TABLE ${quote(`identity_premigration_${table}`)} AS SELECT * FROM ${quote(table)}`);
    };
    const count = (label: string): void => {
      report.rewrites[label] = (report.rewrites[label] ?? 0) + 1;
    };

    if (has("memory_revisions", "scope_id")) {
      const byTarget = new Map<string, string[]>();
      const { rows } = await client.query<{ s: string }>("SELECT DISTINCT scope_id AS s FROM memory_revisions");
      for (const { s } of rows) {
        const next = mapScope(s);
        if (next !== s) byTarget.set(next, [...(byTarget.get(next) ?? []), s]);
      }
      for (const [target, sources] of byTarget) {
        if (sources.length < 2) continue;
        report.notebooksMerged++;
        if (!opts.apply) continue;
        await backup("memory_revisions");
        let offset = 0;
        const heads: string[] = [];
        for (const source of sources) {
          const moved = await client.query<{ seq: string; body: string }>(
            "UPDATE memory_revisions SET scope_id = $1, seq = seq + $2 WHERE scope_id = $3 RETURNING seq, body",
            [`migrating:${target}`, offset, source],
          );
          const last = moved.rows.reduce((a, r) => (Number(r.seq) > Number(a.seq) ? r : a), moved.rows[0]!);
          offset = Number(last.seq);
          heads.push(last.body);
        }
        await client.query("UPDATE memory_revisions SET scope_id = $1 WHERE scope_id = $2", [
          target,
          `migrating:${target}`,
        ]);
        await client.query(
          "INSERT INTO memory_revisions(scope_id, seq, op, body, author, at) VALUES ($1, $2, 'combine', $3, NULL, $4)",
          [target, offset + 1, heads.filter(Boolean).join("\n"), Date.now()],
        );
      }
    }

    for (const r of PRINCIPAL_REFS) {
      if (!has(r.table, r.column) || r.table === "identities") continue;
      const label = `${r.table}.${r.column}`;
      const { rows } = await client.query<{ ctid: string; v: unknown }>(
        `SELECT ctid::text AS ctid, ${quote(r.column)} AS v FROM ${quote(r.table)} WHERE ${quote(r.column)} IS NOT NULL`,
      );
      for (const row of rows) {
        const old = row.v;
        const rewrite = {
          json: () => rewriteJson(old, rws),
          id: () => mapId(String(old)),
          scope: () => mapScope(String(old)),
          text: () => rw(String(old)),
        };
        const next = rewrite[r.kind]();
        if (JSON.stringify(next) === JSON.stringify(old)) continue;
        count(label);
        if (!opts.apply) continue;
        await backup(r.table);
        await client.query("SAVEPOINT row_write");
        try {
          await client.query(`UPDATE ${quote(r.table)} SET ${quote(r.column)} = $1 WHERE ctid = $2::tid`, [
            r.kind === "json" ? JSON.stringify(next) : next,
            row.ctid,
          ]);
          await client.query("RELEASE SAVEPOINT row_write");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT row_write");
          if ((error as { code?: string }).code !== "23505") throw error;
          await client.query(`DELETE FROM ${quote(r.table)} WHERE ctid = $1::tid`, [row.ctid]);
          count(`${label} (clash, kept existing)`);
        }
      }
    }

    for (const [table, cols] of columns) {
      if (
        !cols.has("id") ||
        !cols.has("json") ||
        table === "principal_links" ||
        table === EMAIL_KEYED ||
        table.startsWith("identity_premigration_")
      )
        continue;
      const { rows } = await client.query<{ id: string; json: unknown }>(`SELECT id, json FROM ${quote(table)}`);
      const label = `${table} (durable map)`;
      let touched = false;
      for (const row of rows) {
        const id = rw(row.id);
        const json = rewriteJson(row.json, rws);
        if (id === row.id && JSON.stringify(json) === JSON.stringify(row.json)) continue;
        count(label);
        touched = true;
        if (!opts.apply) continue;
        await backup(table);
        if (id === row.id) {
          await client.query(`UPDATE ${quote(table)} SET json = $2 WHERE id = $1`, [id, JSON.stringify(json)]);
          continue;
        }
        const clash = await client.query(`SELECT 1 FROM ${quote(table)} WHERE id = $1`, [id]);
        if (clash.rowCount) {
          await client.query(`DELETE FROM ${quote(table)} WHERE id = $1`, [row.id]);
          count(`${label} (clash, kept existing)`);
        } else
          await client.query(`UPDATE ${quote(table)} SET id = $2, json = $3 WHERE id = $1`, [
            row.id,
            id,
            JSON.stringify(json),
          ]);
      }
      if (touched && opts.apply && columns.has("durable_map_versions"))
        await client.query(
          "INSERT INTO durable_map_versions(tbl, v) VALUES ($1, 1) ON CONFLICT (tbl) DO UPDATE SET v = durable_map_versions.v + 1",
          [table],
        );
    }

    if (opts.apply && columns.has("principal_links")) await client.query("DROP TABLE principal_links");
    for (const [label, n] of Object.entries(report.rewrites).sort()) log(`  ${label}: ${n} row(s)`);
    await client.query(opts.apply ? "COMMIT" : "ROLLBACK");
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Tables the migration writes, created ahead of it so a fresh database and a migrated one look the same. */
export async function ensurePrincipalSchema(pool: Pool): Promise<void> {
  for (const statement of PRINCIPAL_SCHEMA) await pool.query(statement);
}
