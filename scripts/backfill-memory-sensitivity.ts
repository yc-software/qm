import { parseArgs } from "node:util";
import pg from "pg";
import type { ModelUtilities } from "../src/agent/agent.ts";
import { createAgent, agentConfigOptions } from "../src/agent/agent-run.ts";
import { configRouteOptions, createModelRoutes } from "../src/model/model-route.ts";
import { loadConfig } from "../src/config.ts";
import { classifyFacts } from "../src/memory/classification.ts";
import type { MemorySensitivity } from "../src/memory/facts.ts";
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

function isCrossScopeRow(row: FactRow): boolean {
  if (row.session_scope_id && row.session_scope_id !== row.scope_id) return true;
  if (row.sources.some((source) => source !== row.scope_id)) return true;
  if (row.sources.length === 0) {
    const lower = row.text.toLowerCase();
    if (lower.includes("(said in ") || lower.includes("[claimed source:")) return true;
  }
  return false;
}

function needsUpdate(row: FactRow, sensitivity: MemorySensitivity): boolean {
  return (
    row.sensitivity !== sensitivity || row.source_unknown || row.sources.length !== 1 || row.sources[0] !== row.scope_id
  );
}

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    scope: { type: "string" },
    limit: { type: "string" },
    batch: { type: "string", default: "20" },
  },
});

const batchSize = Number(values.batch);
if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error(`invalid --batch: ${values.batch}`);
const limit = values.limit !== undefined ? Number(values.limit) : undefined;
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error(`invalid --limit: ${values.limit}`);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const config = loadConfig();
const baseAgent = createAgent({
  ...agentConfigOptions(config),
  routes: createModelRoutes(configRouteOptions(config)),
  tempDirPrefix: "membackfill",
});
if (!baseAgent.oneShot) throw new Error("model agent has no oneShot configured");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const params: unknown[] = [values.scope ?? null];
  const limitClause = limit !== undefined ? ` LIMIT ${limit}` : "";
  const { rows } = await client.query<FactRow>(
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
      const slice = eligible.slice(i, i + batchSize);
      let batchFailed = false;
      const agent: ModelUtilities = {
        async oneShot(systemPrompt, prompt, purpose) {
          try {
            const out = await baseAgent.oneShot!(systemPrompt, prompt, purpose);
            if (!out?.trim()) batchFailed = true;
            return out;
          } catch (e) {
            batchFailed = true;
            throw e;
          }
        },
      };
      const labels = await withTenant(tenantId, () =>
        classifyFacts(
          agent,
          slice.map((row) => row.text),
          scopeId,
          undefined,
        ),
      );
      if (batchFailed) {
        skippedModelErrors += slice.length;
        continue;
      }
      const updates: Array<{ tenantId: string; id: string; scopeId: string; sensitivity: MemorySensitivity }> = [];
      for (const [index, row] of slice.entries()) {
        const label = labels[index]!;
        if (label === "unknown") {
          skippedUnknown++;
          continue;
        }
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
        await client.query(
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
  }

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
  await client.end();
}
