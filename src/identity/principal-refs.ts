import type { PoolClient } from "pg";
import { normalize } from "../memory/notebook.ts";
import { parseMemoryRecords, renderMemoryRecords, type MemoryRecords } from "../memory/records.ts";

type RefKind = "id" | "scope" | "text" | "json";

export interface PrincipalRef {
  table: string;
  column: string;
  kind: RefKind;
}

const ref = (table: string, column: string, kind: RefKind): PrincipalRef => ({ table, column, kind });

export const PRINCIPAL_REFS: readonly PrincipalRef[] = [
  ref("identities", "principal_id", "id"),
  ref("participants", "principal_id", "id"),
  ref("admin_grants", "principal_id", "id"),
  ref("admin_grants", "scope_id", "scope"),
  ref("admin_grants", "granted_by", "id"),
  ref("acl_grants", "owner_scope_id", "scope"),
  ref("acl_grants", "grantee_scope_id", "scope"),
  ref("acl_grants", "granted_by", "id"),
  ref("audit_log", "principal_id", "id"),
  ref("audit_log", "scope_label", "text"),
  ref("budget_spend", "principal_id", "id"),
  ref("rate_limit_windows", "principal_id", "id"),
  ref("directory_members", "principal_id", "id"),
  ref("directory_channel_members", "principal_id", "id"),
  ref("directory_group_members", "principal_id", "id"),
  ref("environment_attachments", "scope_id", "scope"),
  ref("environment_attachments", "attached_by", "id"),
  ref("file_artifacts", "owner_scope_id", "scope"),
  ref("file_artifacts", "created_by", "id"),
  ref("file_artifacts", "created_in_scope", "scope"),
  ref("file_uploads", "actor_id", "id"),
  ref("memory_revisions", "scope_id", "scope"),
  ref("memory_revisions", "author", "id"),
  ref("memory_revisions", "records", "json"),
  ref("process_sessions", "scope_id", "scope"),
  ref("process_sessions", "session_ref", "text"),
  ref("sessions", "scope_id", "scope"),
  ref("sessions", "thread_ref", "text"),
  ref("cron_fires", "thread_ref", "text"),
  ref("deliveries", "destination", "json"),
  ref("deliveries", "recipient_thread_ref", "text"),
  ref("session_pins", "added_by", "id"),
  ref("session_entry_search", "author", "id"),
  ref("channel_policy", "set_by", "id"),
  ref("channel_policy_history", "set_by", "id"),
  ref("session_tape", "author", "id"),
  ref("ambient_judgments", "asked_by", "id"),
  ref("app_page_views", "viewer", "id"),
  ref("run_signals", "payload", "json"),
  ref("run_signals", "dedupe_key", "text"),
  ref("session_entries", "scope_label", "text"),
  ref("session_llm_requests", "scope_label", "text"),
  ref("session_tape", "scope_label", "text"),
  ref("turn_metrics", "scope_label", "text"),
  ref("error_events", "scope_label", "text"),
  ref("egress_events", "principal_id", "id"),
  ref("egress_events", "scope_label", "text"),
  ref("credential_usage", "principal_id", "id"),
  ref("credential_usage", "scope_label", "text"),
];

export const NOT_PRINCIPAL_COLUMNS: readonly string[] = [
  "principals.principal_id",
  "session_leases.holder",
  "auth_broker_sessions.email",
  "identities.linked_by",
  "identities.email",
];

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const TOKEN_PATTERN = (id: string): string => `(^|[^0-9A-Za-z-])${id.replace(/[^0-9A-Za-z-]/g, "")}(?![0-9A-Za-z-])`;

async function tableColumns(client: PoolClient): Promise<Map<string, Set<string>>> {
  const { rows } = await client.query<{ table_name: string; column_name: string }>(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()",
  );
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = out.get(r.table_name) ?? new Set<string>();
    set.add(r.column_name);
    out.set(r.table_name, set);
  }
  return out;
}

async function uniquePeers(client: PoolClient, table: string, column: string): Promise<string[][]> {
  const { rows } = await client.query<{ cols: string[] }>(
    `SELECT array_agg(a.attname::text ORDER BY a.attnum) AS cols
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE c.relname = $1 AND i.indisunique
      GROUP BY i.indexrelid`,
    [table],
  );
  return rows.filter((r) => r.cols.includes(column)).map((r) => r.cols.filter((c) => c !== column));
}

async function repointEquals(client: PoolClient, table: string, column: string, from: string, to: string) {
  for (const peers of await uniquePeers(client, table, column)) {
    const same = peers.map((p) => `k.${quote(p)} IS NOT DISTINCT FROM d.${quote(p)}`).join(" AND ");
    await client.query(
      `DELETE FROM ${quote(table)} d WHERE d.${quote(column)}::text = $1 AND EXISTS (
         SELECT 1 FROM ${quote(table)} k WHERE k.${quote(column)}::text = $2${same ? ` AND ${same}` : ""})`,
      [from, to],
    );
  }
  await client.query(`UPDATE ${quote(table)} SET ${quote(column)} = $2 WHERE ${quote(column)}::text = $1`, [from, to]);
}

export async function interleaveNotebooks(
  client: PoolClient,
  target: string,
  sources: readonly string[],
): Promise<number> {
  const { rows } = await client.query<{
    scope_id: string;
    seq: string;
    op: string;
    body: string;
    author: string | null;
    at: string;
    records: unknown;
  }>("SELECT scope_id, seq::text, op, body, author, at::text, records FROM memory_revisions WHERE scope_id = ANY($1)", [
    sources,
  ]);
  const merged = interleaveRevisions(
    sources,
    rows.map((r) => ({ ...r, seq: Number(r.seq), at: Number(r.at) })),
  );
  await client.query("DELETE FROM memory_revisions WHERE scope_id = ANY($1)", [sources]);
  for (const [i, r] of merged.entries())
    await client.query(
      "INSERT INTO memory_revisions(scope_id, seq, op, body, author, at, records) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [target, i + 1, r.op, renderMemoryRecords(r.records), r.author, r.at, JSON.stringify(r.records)],
    );
  return merged.length;
}

interface SourceRevision {
  scope_id: string;
  seq: number;
  op: string;
  body: string;
  author: string | null;
  at: number;
  records: unknown;
}

export function interleaveRevisions(sources: readonly string[], rows: readonly SourceRevision[]) {
  const order = (r: SourceRevision): number => sources.indexOf(r.scope_id);
  const sorted = [...rows].sort((a, b) => a.at - b.at || order(a) - order(b) || a.seq - b.seq);
  const heads = new Map<string, MemoryRecords>();
  return sorted.map((r) => {
    heads.set(r.scope_id, parseMemoryRecords(r.scope_id, r.body, r.records ?? undefined));
    const seen = new Set<string>();
    const records: MemoryRecords["records"] = [];
    for (const scope of sources)
      for (const record of heads.get(scope)?.records ?? []) {
        const k = normalize(record.text);
        if (seen.has(k) || seen.has(`id:${record.id}`)) continue;
        seen.add(k).add(`id:${record.id}`);
        records.push(record);
      }
    return { op: r.op, author: r.author, at: r.at, records: { version: 1 as const, records } };
  });
}

export async function combineReferences(client: PoolClient, keep: string, drop: string): Promise<void> {
  const columns = await tableColumns(client);
  const has = (t: string, c: string): boolean => columns.get(t)?.has(c) ?? false;
  if (has("memory_revisions", "scope_id"))
    await interleaveNotebooks(client, `personal:${keep}`, [`personal:${keep}`, `personal:${drop}`]);
  const pattern = TOKEN_PATTERN(drop);
  for (const r of PRINCIPAL_REFS) {
    if (!has(r.table, r.column)) continue;
    const t = quote(r.table);
    const c = quote(r.column);
    if (r.kind === "id") await repointEquals(client, r.table, r.column, drop, keep);
    else if (r.kind === "scope") await repointEquals(client, r.table, r.column, `personal:${drop}`, `personal:${keep}`);
    else if (r.kind === "text")
      await client.query(`UPDATE ${t} SET ${c} = regexp_replace(${c}, $1, '\\1' || $2, 'g') WHERE ${c} ~ $1`, [
        pattern,
        keep,
      ]);
    else
      await client.query(
        `UPDATE ${t} SET ${c} = regexp_replace(${c}::text, $1, '\\1' || $2, 'g')::jsonb WHERE ${c}::text ~ $1`,
        [pattern, keep],
      );
  }
  for (const [table, cols] of columns) {
    if (!cols.has("id") || !cols.has("json")) continue;
    const t = quote(table);
    const { rows } = await client.query<{ id: string }>(`SELECT id FROM ${t} WHERE id ~ $1`, [pattern]);
    for (const { id } of rows) {
      const next = id.replace(new RegExp(pattern, "g"), `$1${keep}`);
      const clash = await client.query(`SELECT 1 FROM ${t} WHERE id = $1`, [next]);
      if (clash.rowCount) await client.query(`DELETE FROM ${t} WHERE id = $1`, [id]);
      else await client.query(`UPDATE ${t} SET id = $2 WHERE id = $1`, [id, next]);
    }
    await client.query(
      `UPDATE ${t} SET json = regexp_replace(json::text, $1, '\\1' || $2, 'g')::jsonb WHERE json::text ~ $1`,
      [pattern, keep],
    );
    if (columns.has("durable_map_versions"))
      await client.query(
        "INSERT INTO durable_map_versions(tbl, v) VALUES ($1, 1) ON CONFLICT (tbl) DO UPDATE SET v = durable_map_versions.v + 1",
        [table],
      );
  }
  await client.query("DELETE FROM principals WHERE principal_id = $1", [drop]);
}
