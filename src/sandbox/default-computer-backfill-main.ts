import { parseArgs } from "node:util";
import pg from "pg";
import { loadConfig } from "../config.ts";
import { pgConnectionOptions } from "../persistence/pg-pool.ts";
import { inTenant } from "../tenants/claim.ts";
import { errText, swallow } from "../util/errors.ts";
import type { ScopeId } from "../types.ts";
import { buildApp } from "../wiring.ts";
const CANDIDATES = `
  WITH excluded AS (
    SELECT l.alias_id FROM user_links l JOIN users u ON u.id = l.user_id AND u.tenant_id = l.tenant_id
     WHERE u.offboarded_at IS NOT NULL OR u.kind <> 'person'
  )
  SELECT DISTINCT x.scope,
         EXISTS (SELECT 1 FROM sandbox_defaults d WHERE d.id = x.scope) AS has_default
    FROM (
      SELECT 'personal:' || primary_alias AS scope FROM users WHERE primary_alias LIKE 'oidc:%'
      UNION SELECT 'personal:' || principal_id FROM admin_grants WHERE principal_id LIKE 'oidc:%'
      UNION SELECT scope_id FROM sessions WHERE scope_id LIKE 'personal:oidc:%'
    ) x
   WHERE substr(x.scope, 10) NOT IN (SELECT alias_id FROM excluded)
   ORDER BY x.scope`;

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    tenant: { type: "string", multiple: true },
  },
});

const config = loadConfig();
if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
const client = new pg.Client(pgConnectionOptions(config.databaseUrl));
await client.connect();

async function inTenantTx<T>(tenant: string, work: () => Promise<T>): Promise<T> {
  await client.query("BEGIN READ ONLY");
  try {
    await client.query("SELECT set_config('qm.tenant_id', $1, true)", [tenant]);
    const result = await work();
    await client.query("ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch((rollback: unknown) => swallow("backfill rollback", rollback));
    throw error;
  }
}

const serving = (await client.query("SELECT qm_serving_tenants()::text AS t")).rows.map((r) => String(r.t));
const tenants = values.tenant?.length ? serving.filter((t) => values.tenant!.includes(t)) : serving;
const built = values.apply ? buildApp(config) : undefined;
const totals = { tenants: 0, people: 0, alreadySet: 0, created: 0, legacyImportSkipped: 0, failed: 0 };

try {
  for (const tenant of tenants) {
    const plan = await inTenantTx(tenant, async () => {
      const rows = (await client.query(CANDIDATES)).rows as Array<{ scope: ScopeId; has_default: boolean }>;
      const marker = (await client.query("SELECT 1 FROM sandbox_resource_rollout LIMIT 1")).rowCount ?? 0;
      return { rows, importDone: marker > 0 };
    });
    const missing = plan.rows.filter((row) => !row.has_default).map((row) => row.scope);
    totals.tenants++;
    totals.people += plan.rows.length;
    totals.alreadySet += plan.rows.length - missing.length;
    const line: Record<string, unknown> = {
      tenant,
      people: plan.rows.length,
      missing: missing.length,
      importDone: plan.importDone,
    };
    if (built && missing.length) {
      await inTenant(tenant, async () => {
        const resources = built.sandboxResources;
        try {
          if (await resources.skipLegacyImport()) {
            totals.legacyImportSkipped++;
            line.legacyImportSkipped = true;
          }
          let created = 0;
          for (const scope of missing) {
            line.scope = scope;
            const ensured = await resources.ensureDefault(scope);
            if (ensured?.created) created++;
          }
          delete line.scope;
          totals.created += created;
          line.created = created;
        } catch (error) {
          totals.failed++;
          line.error = errText(error);
        }
      });
    }
    console.log(`[default-computer-backfill] ${JSON.stringify(line)}`);
  }
} finally {
  await client.end();
  await built?.runtime.stop();
}
console.log(
  `[default-computer-backfill] ${values.apply ? "applied" : "dry run (pass --apply to write)"} ${JSON.stringify(totals)}`,
);
if (totals.failed) process.exitCode = 1;
