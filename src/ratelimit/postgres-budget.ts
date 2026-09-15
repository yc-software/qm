import { createPgPool, withPgTransaction, type PoolClient } from "../persistence/pg-pool.ts";
import type { BudgetCheck, BudgetTracker } from "./budget.ts";
import { DEFAULT_BUDGET_WINDOW_MS } from "./budget.ts";
import { errMessage } from "../util/errors.ts";

function finiteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function assertAmount(value: number, name: string): void {
  if (!finiteNonnegative(value)) throw new Error(`${name} must be finite and nonnegative`);
}

export function createPostgresBudgetTracker(
  connectionString: string,
  opts: { limitUsd?: number; orgLimitUsd?: number; windowMs?: number } = {},
): BudgetTracker {
  const limitUsd = opts.limitUsd ?? Infinity;
  const orgLimitUsd = opts.orgLimitUsd ?? Infinity;
  const windowMs = opts.windowMs ?? DEFAULT_BUDGET_WINDOW_MS;
  const orgKey = "@org";
  const enabled = Number.isFinite(limitUsd) || Number.isFinite(orgLimitUsd);
  const pg = createPgPool(connectionString, [
    {
      id: "ratelimit/budget/0001",
      statements: [
        `CREATE TABLE IF NOT EXISTS budget_spend(
        id BIGSERIAL PRIMARY KEY,
        principal_id TEXT NOT NULL,
        at BIGINT NOT NULL,
        usd DOUBLE PRECISION NOT NULL
      )`,
        `CREATE INDEX IF NOT EXISTS budget_spend_by_principal_at ON budget_spend(principal_id, at)`,
      ],
    },
    {
      id: "ratelimit/budget/0002",
      statements: [
        `CREATE TABLE IF NOT EXISTS budget_operations(
          operation_id TEXT PRIMARY KEY,
          principal_id TEXT NOT NULL,
          model TEXT NOT NULL,
          reserved_at BIGINT NOT NULL,
          reserved_usd DOUBLE PRECISION NOT NULL CHECK (reserved_usd >= 0 AND reserved_usd < 'Infinity'::float8),
          known_usd DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (known_usd >= 0 AND known_usd < 'Infinity'::float8),
          checkpoint_at BIGINT,
          price_basis TEXT NOT NULL,
          settled_at BIGINT,
          settled_usd DOUBLE PRECISION CHECK (settled_usd >= 0 AND settled_usd < 'Infinity'::float8)
        )`,
        `CREATE INDEX IF NOT EXISTS budget_operations_by_principal_at ON budget_operations(principal_id, reserved_at)`,
        `CREATE INDEX IF NOT EXISTS budget_operations_by_at ON budget_operations(reserved_at)`,
      ],
    },
  ]);

  async function legacySpent(client: PoolClient | null, principalId: string, cutoff: number): Promise<number> {
    const text = "SELECT COALESCE(SUM(usd), 0) AS spent FROM budget_spend WHERE principal_id = $1 AND at >= $2";
    const rows = client
      ? (await client.query(text, [principalId, cutoff])).rows
      : await pg.q(text, [principalId, cutoff]);
    return Number(rows[0]?.spent ?? 0);
  }

  async function operationSpent(client: PoolClient | null, principalId: string, cutoff: number): Promise<number> {
    const org = principalId === orgKey;
    const text = `SELECT COALESCE(SUM(COALESCE(settled_usd, GREATEST(reserved_usd, known_usd))), 0) AS spent
      FROM budget_operations WHERE reserved_at >= $1${org ? "" : " AND principal_id = $2"}`;
    const params = org ? [cutoff] : [cutoff, principalId];
    const rows = client ? (await client.query(text, params)).rows : await pg.q(text, params);
    return Number(rows[0]?.spent ?? 0);
  }

  async function spent(client: PoolClient | null, principalId: string, now: number): Promise<number> {
    const cutoff = now - windowMs;
    return (await legacySpent(client, principalId, cutoff)) + (await operationSpent(client, principalId, cutoff));
  }

  async function checkAt(client: PoolClient | null, principalId: string, now: number): Promise<BudgetCheck> {
    const spentUsd = await spent(client, principalId, now);
    if (spentUsd >= limitUsd) return { allowed: false, spentUsd, limitUsd, reason: "limit" };
    const orgSpent = await spent(client, orgKey, now);
    return orgSpent >= orgLimitUsd
      ? { allowed: false, spentUsd: orgSpent, limitUsd: orgLimitUsd, reason: "limit" }
      : { allowed: true, spentUsd, limitUsd };
  }

  return {
    enabled,
    async check(principalId, now = Date.now()) {
      return checkAt(null, principalId, now);
    },
    async record(principalId, costUsd, now = Date.now()) {
      assertAmount(costUsd, "costUsd");
      try {
        for (const key of [principalId, orgKey]) {
          await pg.q(
            `WITH ins AS (INSERT INTO budget_spend(principal_id, at, usd) VALUES ($1, $2, $3))
             DELETE FROM budget_spend WHERE principal_id = $1 AND at < $4`,
            [key, now, costUsd, now - windowMs],
          );
        }
      } catch (err) {
        console.error("[budget] failed to persist spend:", errMessage(err));
      }
    },
    async lookupReservation(input) {
      const now = input.now ?? Date.now();
      return withPgTransaction(await pg.pool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["budget:@org"]);
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`budget:${input.principalId}`]);
        const prior = await client.query<{
          principal_id: string;
          model: string;
          price_basis: string;
        }>("SELECT principal_id, model, price_basis FROM budget_operations WHERE operation_id = $1", [
          input.operationId,
        ]);
        const existing = prior.rows[0];
        if (!existing) return undefined;
        if (existing.principal_id !== input.principalId || existing.model !== input.model)
          throw new Error(`budget operation identity conflict: ${input.operationId}`);
        return {
          allowed: true,
          spentUsd: await spent(client, input.principalId, now),
          limitUsd,
          priceBasis: existing.price_basis,
        };
      });
    },
    async reserve(input) {
      assertAmount(input.reservedUsd, "reservedUsd");
      const now = input.now ?? Date.now();
      return withPgTransaction(await pg.pool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["budget:@org"]);
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`budget:${input.principalId}`]);
        const prior = await client.query<{
          principal_id: string;
          model: string;
          price_basis: string;
        }>("SELECT principal_id, model, price_basis FROM budget_operations WHERE operation_id = $1", [
          input.operationId,
        ]);
        const existing = prior.rows[0];
        if (existing) {
          if (existing.principal_id !== input.principalId || existing.model !== input.model)
            throw new Error(`budget operation identity conflict: ${input.operationId}`);
          return {
            allowed: true,
            spentUsd: await spent(client, input.principalId, now),
            limitUsd,
            priceBasis: existing.price_basis,
          };
        }
        const principalSpent = await spent(client, input.principalId, now);
        if (principalSpent >= limitUsd)
          return {
            allowed: false,
            spentUsd: principalSpent,
            limitUsd,
            reason: "limit",
            priceBasis: input.priceBasis ?? "",
          };
        const orgSpent = await spent(client, orgKey, now);
        if (orgSpent >= orgLimitUsd)
          return {
            allowed: false,
            spentUsd: orgSpent,
            limitUsd: orgLimitUsd,
            reason: "limit",
            priceBasis: input.priceBasis ?? "",
          };
        const priceBasis = input.priceBasis ?? "";
        await client.query(
          `INSERT INTO budget_operations(operation_id, principal_id, model, reserved_at, reserved_usd, price_basis)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [input.operationId, input.principalId, input.model, now, input.reservedUsd, priceBasis],
        );
        return { allowed: true, spentUsd: principalSpent + input.reservedUsd, limitUsd, priceBasis };
      });
    },
    async checkpoint(input) {
      assertAmount(input.knownUsd, "knownUsd");
      await withPgTransaction(await pg.pool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["budget:@org"]);
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`budget:${input.principalId}`]);
        const result = await client.query<{
          principal_id: string;
          model: string;
          settled_usd: number | null;
        }>(
          `SELECT principal_id, model, settled_usd FROM budget_operations
           WHERE operation_id = $1 FOR UPDATE`,
          [input.operationId],
        );
        const existing = result.rows[0];
        if (!existing) throw new Error(`budget reservation not found: ${input.operationId}`);
        if (existing.principal_id !== input.principalId || existing.model !== input.model)
          throw new Error(`budget operation identity conflict: ${input.operationId}`);
        if (existing.settled_usd === null)
          await client.query(
            `UPDATE budget_operations
             SET checkpoint_at = $2, known_usd = GREATEST(known_usd, $3)
             WHERE operation_id = $1`,
            [input.operationId, input.now ?? Date.now(), input.knownUsd],
          );
      });
    },
    async settle(input) {
      assertAmount(input.settledUsd, "settledUsd");
      await withPgTransaction(await pg.pool(), async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["budget:@org"]);
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`budget:${input.principalId}`]);
        const result = await client.query<{
          principal_id: string;
          model: string;
          settled_usd: number | null;
        }>(
          `SELECT principal_id, model, settled_usd FROM budget_operations
           WHERE operation_id = $1 FOR UPDATE`,
          [input.operationId],
        );
        const existing = result.rows[0];
        if (!existing) throw new Error(`budget reservation not found: ${input.operationId}`);
        if (existing.principal_id !== input.principalId || existing.model !== input.model)
          throw new Error(`budget operation identity conflict: ${input.operationId}`);
        if (existing.settled_usd !== null && Number(existing.settled_usd) !== input.settledUsd)
          throw new Error(`budget operation settlement conflict: ${input.operationId}`);
        if (existing.settled_usd === null)
          await client.query(`UPDATE budget_operations SET settled_at = $2, settled_usd = $3 WHERE operation_id = $1`, [
            input.operationId,
            input.now ?? Date.now(),
            input.settledUsd,
          ]);
      });
    },
  };
}
