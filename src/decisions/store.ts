import type { PoolClient } from "pg";
import { createPgPool, withPgTransaction, tenantCols } from "../persistence/pg-pool.ts";
import { checkRuleSet, type DecisionHook, type DecisionProvider, type DecisionRule } from "./decisions.ts";
import { perTenant } from "../tenant.ts";

interface DecisionWriter {
  actorId: string;
}

export interface DecisionStore {
  providers(ids?: readonly string[]): Promise<DecisionProvider[]>;
  rules(hook?: DecisionHook): Promise<DecisionRule[]>;
  saveProvider(provider: DecisionProvider, by: DecisionWriter): Promise<void>;
  removeProvider(id: string): Promise<void>;
  saveRule(rule: DecisionRule, by: DecisionWriter): Promise<void>;
  removeRule(id: string): Promise<void>;
}

const toRule = (r: Record<string, unknown>): DecisionRule => ({
  id: r.rule_id as string,
  hook: r.hook as DecisionHook,
  question: r.question as string,
  options: r.options as DecisionRule["options"],
  model: { provider: r.provider_id as string, model: r.model as string },
  mode: r.mode as DecisionRule["mode"],
  onError: r.on_error as string,
});

const RULES = "SELECT * FROM decision_rules";
const CACHE_MS = 10_000;
const MAX_STORED_RULES = 100;
const MAX_PROVIDERS = 20;

export function createPostgresDecisionStore(connectionString: string): DecisionStore {
  const { q, pool } = createPgPool(connectionString, []);
  const cached = perTenant(() => ({
    active: new Map<DecisionHook, { at: number; rules: Promise<DecisionRule[]> }>(),
    known: undefined as { at: number; providers: Promise<DecisionProvider[]> } | undefined,
  }));
  const write = async (fn: (db: PoolClient) => Promise<unknown>) => {
    await withPgTransaction(await pool(), async (db) => {
      await db.query("LOCK TABLE decision_rules IN SHARE ROW EXCLUSIVE MODE");
      await fn(db);
    });
    cached().active.clear();
    cached().known = undefined;
  };
  return {
    async providers(ids) {
      const cache = cached();
      if (!cache.known || Date.now() - cache.known.at >= CACHE_MS) {
        const providers = q("SELECT * FROM decision_providers ORDER BY provider_id").then((rows) =>
          rows.map((r) => ({
            id: r.provider_id as string,
            protocol: r.protocol as DecisionProvider["protocol"],
            ...(r.base_url ? { baseUrl: r.base_url as string, credential: r.credential as string } : {}),
          })),
        );
        cache.known = { at: Date.now(), providers };
        providers.catch(() => (cache.known = undefined));
      }
      const all = await cache.known.providers;
      return ids ? all.filter((p) => ids.includes(p.id)) : all;
    },
    async rules(hook) {
      if (!hook) return (await q(`${RULES} ORDER BY rule_id`)).map(toRule);
      const { active } = cached();
      const hit = active.get(hook);
      if (hit && Date.now() - hit.at < CACHE_MS) return hit.rules;
      const rules = q(`${RULES} WHERE hook = $1 AND mode <> 'off' ORDER BY rule_id`, [hook]).then((r) => r.map(toRule));
      active.set(hook, { at: Date.now(), rules });
      rules.catch(() => active.delete(hook));
      return rules;
    },
    saveProvider: (p, by) =>
      write(async (db) => {
        const { rows } = await db.query("SELECT count(*)::int AS n FROM decision_providers WHERE provider_id <> $1", [
          p.id,
        ]);
        if (rows[0].n >= MAX_PROVIDERS)
          throw new Error(`at most ${MAX_PROVIDERS} decision providers; remove one first`);
        await db.query(
          `INSERT INTO decision_providers (provider_id, protocol, base_url, credential, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (${tenantCols("provider_id")}) DO UPDATE SET protocol = $2, base_url = $3, credential = $4, updated_by = $5, updated_at = $6`,
          [p.id, p.protocol, p.baseUrl ?? null, p.credential ?? null, by.actorId, Date.now()],
        );
      }),
    async removeProvider(id) {
      try {
        await write((db) => db.query("DELETE FROM decision_providers WHERE provider_id = $1", [id]));
      } catch (error) {
        if ((error as { code?: string }).code === "23503")
          throw new Error(`decision provider ${id} is still used by a rule`, { cause: error });
        throw error;
      }
    },
    saveRule: (rule, by) =>
      write(async (db) => {
        const { rows } = await db.query("SELECT count(*)::int AS n FROM decision_rules WHERE rule_id <> $1", [rule.id]);
        if (rows[0].n >= MAX_STORED_RULES)
          throw new Error(`at most ${MAX_STORED_RULES} decision rules; remove one first`);
        const others = await db.query(`${RULES} WHERE rule_id <> $1 AND mode <> 'off' ORDER BY rule_id`, [rule.id]);
        const error = checkRuleSet([...others.rows.map(toRule), rule]);
        if (error) throw new Error(error);
        await db.query(
          `INSERT INTO decision_rules
             (rule_id, hook, question, options, provider_id, model, mode, on_error, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (${tenantCols("rule_id")}) DO UPDATE SET hook = $2, question = $3, options = $4, provider_id = $5, model = $6,
             mode = $7, on_error = $8, updated_by = $9, updated_at = $10`,
          [
            rule.id,
            rule.hook,
            rule.question,
            JSON.stringify(rule.options),
            rule.model.provider,
            rule.model.model,
            rule.mode,
            rule.onError,
            by.actorId,
            Date.now(),
          ],
        );
      }),
    removeRule: (id) => write((db) => db.query("DELETE FROM decision_rules WHERE rule_id = $1", [id])),
  };
}
