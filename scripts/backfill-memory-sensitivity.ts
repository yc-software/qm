import { parseArgs } from "node:util";
import pg from "pg";
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
  text: string;
  sensitivity: string;
  sources: string[];
  source_unknown: boolean;
}

function isLegacyCrossScope(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("(said in ") || lower.includes("[claimed source:");
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
const agent = createAgent({
  ...agentConfigOptions(config),
  routes: createModelRoutes(configRouteOptions(config)),
  tempDirPrefix: "membackfill",
});
if (!agent.oneShot) throw new Error("model agent has no oneShot configured");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const params: unknown[] = [values.scope ?? null];
  const limitClause = limit !== undefined ? ` LIMIT ${limit}` : "";
  const { rows } = await client.query<FactRow>(
    `SELECT tenant_id, id, scope_id, text, sensitivity, sources, source_unknown
       FROM memory_facts
      WHERE deleted_at IS NULL
        AND (($1::text IS NULL AND scope_id LIKE 'personal:%') OR scope_id = $1)
      ORDER BY scope_id, id${limitClause}`,
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
  let skippedUnknown = 0;
  let unchanged = 0;
  let changed = 0;
  const at = Date.now();

  for (const scopeRows of byScope.values()) {
    const { tenant_id: tenantId, scope_id: scopeId } = scopeRows[0]!;
    const eligible: FactRow[] = [];
    for (const row of scopeRows) {
      if (isLegacyCrossScope(row.text)) {
        skippedCrossScope++;
        continue;
      }
      eligible.push(row);
    }
    for (let i = 0; i < eligible.length; i += batchSize) {
      const slice = eligible.slice(i, i + batchSize);
      const labels = await withTenant(tenantId, () =>
        classifyFacts(
          agent,
          slice.map((row) => row.text),
          scopeId,
          undefined,
        ),
      );
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
