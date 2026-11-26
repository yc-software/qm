import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { createAgent, agentConfigOptions } from "../src/agent/agent-run.ts";
import { configRouteOptions, createModelRoutes } from "../src/model/model-route.ts";
import { loadConfig } from "../src/config.ts";
import { classifyFacts } from "../src/memory/classification.ts";
import type { MemorySensitivity } from "../src/memory/facts.ts";
import { pgConnectionOptions } from "../src/persistence/pg-pool.ts";
import { withTenant } from "../src/tenants/context.ts";

interface FactRow {
  tenant_id: string;
  id: string;
  scope_id: string;
  session_scope_id: string | null;
  text: string;
  sensitivity: string;
  sources: string[];
  source_unknown: boolean;
}

export function isCrossScopeRow(row: Pick<FactRow, "scope_id" | "session_scope_id" | "sources">): boolean {
  if (row.session_scope_id && row.session_scope_id !== row.scope_id) return true;
  if (row.sources.length === 0) return false;
  if (!row.sources.includes(row.scope_id)) return true;
  return row.sources.some((source) => source.startsWith("personal:") && source !== row.scope_id);
}

export function needsUpdate(
  row: Pick<FactRow, "scope_id" | "sensitivity" | "sources" | "source_unknown">,
  sensitivity: MemorySensitivity,
): boolean {
  return (
    row.sensitivity !== sensitivity || row.source_unknown || row.sources.length !== 1 || row.sources[0] !== row.scope_id
  );
}

export async function classifyBatchWithSplit<T extends { id: string; text: string }>(
  slice: readonly T[],
  classify: (texts: readonly string[]) => Promise<{ labels: MemorySensitivity[]; error?: string }>,
  onError: (batch: readonly T[], error: string) => void,
): Promise<Array<{ row: T; label?: MemorySensitivity; failed?: boolean }>> {
  const { labels, error } = await classify(slice.map((row) => row.text));
  if (!error) return slice.map((row, index) => ({ row, label: labels[index] }));
  if (slice.length > 1) {
    const mid = Math.ceil(slice.length / 2);
    const left = await classifyBatchWithSplit(slice.slice(0, mid), classify, onError);
    const right = await classifyBatchWithSplit(slice.slice(mid), classify, onError);
    return [...left, ...right];
  }
  onError(slice, error);
  return slice.map((row) => ({ row, failed: true }));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      scope: { type: "string" },
      limit: { type: "string" },
      batch: { type: "string", default: "10" },
      concurrency: { type: "string", default: "4" },
    },
  });

  const batchSize = Number(values.batch);
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error(`invalid --batch: ${values.batch}`);
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`invalid --concurrency: ${values.concurrency}`);
  }
  const limit = values.limit !== undefined ? Number(values.limit) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`invalid --limit: ${values.limit}`);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const config = loadConfig();
  const agent = createAgent({
    ...agentConfigOptions(config),
    routes: createModelRoutes(configRouteOptions(config)),
    tempDirPrefix: "membackfill",
  });
  if (!agent.oneShot) throw new Error("model agent has no oneShot configured");

  const pool = new pg.Pool({ ...pgConnectionOptions(databaseUrl), max: Math.min(concurrency, 10) });
  try {
    const params: unknown[] = [values.scope ?? null];
    const limitClause = limit !== undefined ? ` LIMIT ${limit}` : "";
    const { rows } = await pool.query<FactRow>(
      `SELECT f.tenant_id, f.id, f.scope_id, s.scope_id AS session_scope_id,
              f.text, f.sensitivity, f.sources, f.source_unknown
         FROM memory_facts f
         LEFT JOIN sessions s ON s.tenant_id = f.tenant_id AND s.id = f.session_id
        WHERE f.deleted_at IS NULL
          AND (($1::text IS NULL AND f.scope_id LIKE 'personal:%') OR f.scope_id = $1)
        ORDER BY f.scope_id, f.id${limitClause}`,
      params,
    );

    const byScope = new Map<string, FactRow[]>();
    for (const row of rows) {
      const key = `${row.tenant_id}\0${row.scope_id}`;
      const list = byScope.get(key) ?? [];
      list.push(row);
      byScope.set(key, list);
    }

    const transitions: Record<string, number> = {};
    const samples: Record<string, string[]> = { ordinary: [], sensitive: [] };
    let skippedCrossScope = 0;
    let skippedModelErrors = 0;
    let skippedUnknown = 0;
    let unchanged = 0;
    let changed = 0;
    const at = Date.now();

    const jobs: Array<{ tenantId: string; scopeId: string; slice: FactRow[] }> = [];
    for (const scopeRows of byScope.values()) {
      const { tenant_id: tenantId, scope_id: scopeId } = scopeRows[0]!;
      const eligible: FactRow[] = [];
      for (const row of scopeRows) {
        if (isCrossScopeRow(row)) {
          skippedCrossScope++;
          continue;
        }
        eligible.push(row);
      }
      for (let i = 0; i < eligible.length; i += batchSize) {
        jobs.push({ tenantId, scopeId, slice: eligible.slice(i, i + batchSize) });
      }
    }

    let nextJob = 0;
    const worker = async () => {
      while (nextJob < jobs.length) {
        const job = jobs[nextJob++]!;
        const results = await classifyBatchWithSplit(
          job.slice,
          (texts) => withTenant(job.tenantId, () => classifyFacts(agent, texts, job.scopeId, undefined)),
          (batch, error) => {
            console.error(
              `[${job.scopeId}] classification batch failed (${batch[0]!.id}..${batch[batch.length - 1]!.id}): ${error}`,
            );
          },
        );
        const updates: Array<{ tenantId: string; id: string; scopeId: string; sensitivity: MemorySensitivity }> = [];
        for (const result of results) {
          if (result.failed) {
            skippedModelErrors++;
            continue;
          }
          const label = result.label!;
          if (label === "unknown") {
            skippedUnknown++;
            continue;
          }
          const { row } = result;
          const key = `${row.sensitivity} -> ${label}`;
          transitions[key] = (transitions[key] ?? 0) + 1;
          const bucket = samples[label];
          if (bucket && bucket.length < 10) bucket.push(`[${row.scope_id}#${row.id}] ${row.text}`);
          if (!needsUpdate(row, label)) {
            unchanged++;
            continue;
          }
          changed++;
          updates.push({ tenantId: row.tenant_id, id: row.id, scopeId: row.scope_id, sensitivity: label });
        }
        if (values.apply && updates.length) {
          await pool.query(
            `UPDATE memory_facts AS f
                SET sensitivity = u.sensitivity,
                    sources = ARRAY[u.scope_id],
                    source_unknown = false,
                    updated_at = $5
               FROM unnest($1::uuid[], $2::bigint[], $3::text[], $4::text[])
                    AS u(tenant_id, id, scope_id, sensitivity)
              WHERE f.tenant_id = u.tenant_id AND f.id = u.id`,
            [
              updates.map((u) => u.tenantId),
              updates.map((u) => u.id),
              updates.map((u) => u.scopeId),
              updates.map((u) => u.sensitivity),
              at,
            ],
          );
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(jobs.length, 1)) }, () => worker()));

    console.log(
      JSON.stringify(
        {
          mode: values.apply ? "apply" : "dry-run",
          scopes: byScope.size,
          total: rows.length,
          changed,
          unchanged,
          skippedCrossScope,
          skippedModelErrors,
          skippedUnknown,
          transitions,
          samples,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
