import type { ScopeId } from "../types.ts";
import { createPgPool, type PgPool } from "../persistence/pg-pool.ts";
import { reportFailureAs } from "../util/errors.ts";
import type { Tenant } from "../tenants/context.ts";

export interface ScopedEvent {
  scopeLabel: ScopeId;
}

interface ScopedEventQuery<E> {
  scopeId?: string;
  limit?: number;
  offset?: number;
  filter?: (e: E) => boolean;
}

export interface ScopedEventSink<E extends ScopedEvent, In> {
  record(input: In): void;
  list(opts?: ScopedEventQuery<E>): E[];
  all(): readonly E[];
}

export interface ScopedEventSinkOptions<E, In> {
  max: number;
  defaultLimit: number;
  stamp: (input: In) => E;
}

export function createScopedEventSink<E extends ScopedEvent, In>(
  opts: ScopedEventSinkOptions<E, In>,
): ScopedEventSink<E, In> {
  const events: E[] = [];
  return {
    record(input) {
      events.push(opts.stamp(input));
      if (events.length > opts.max) events.splice(0, events.length - opts.max);
    },
    list(query = {}) {
      const limit = query.limit ?? opts.defaultLimit;
      return events
        .filter((e) => (query.scopeId ? e.scopeLabel === query.scopeId : true))
        .filter((e) => (query.filter ? query.filter(e) : true))
        .reverse()
        .slice(query.offset ?? 0, (query.offset ?? 0) + limit);
    },
    all: () => events,
  };
}

type TimestampedQuery = { scopeId?: string; since?: number; limit?: number; offset?: number; [k: string]: unknown };

export interface TimestampedEventSink<E extends ScopedEvent & { ts: number }> {
  record(input: Omit<E, "ts">): void;
  list(opts?: TimestampedQuery): Promise<E[]>;
  all(): readonly E[];
}

export function createTimestampedEventSink<E extends ScopedEvent & { ts: number }>(cfg: {
  max: number;
  defaultLimit: number;
  equalityFields?: (string & keyof E)[];
}): TimestampedEventSink<E> {
  const sink = createScopedEventSink<E, Omit<E, "ts">>({
    max: cfg.max,
    defaultLimit: cfg.defaultLimit,
    stamp: (input) => ({ ...input, ts: Date.now() }) as E,
  });
  return {
    record: sink.record,
    list(opts = {}) {
      return Promise.resolve(
        sink.list({
          ...(opts.scopeId !== undefined ? { scopeId: opts.scopeId } : {}),
          ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
          ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
          filter: (e) =>
            (opts.since === undefined || e.ts >= opts.since) &&
            (cfg.equalityFields ?? []).every((f) => opts[f] === undefined || e[f] === opts[f]),
        }),
      );
    },
    all: sink.all,
  };
}

type ColumnKind = "number" | "string" | "boolean";

export type EventColumn<F extends string = string> = readonly [string, F, string, ColumnKind, boolean?];

const CONVERT: Record<ColumnKind, (v: unknown) => unknown> = {
  number: Number,
  string: String,
  boolean: Boolean,
};

export interface PostgresEventSinkConfig<E> {
  connectionString: string;
  table: string;

  columns: readonly EventColumn<keyof E & string>[];
  defaultLimit: number;
  equalityFilters: Record<string, string>;
  persistErrorMessage: string;
}

export interface PostgresEventSink<E> {
  forTenant: PgPool["forTenant"];
  record(t: Tenant, input: Omit<E, "ts">): void;
  flush(): Promise<void>;
  list(t: Tenant, opts?: object): Promise<E[]>;
  count(t: Tenant, opts?: object): Promise<number>;
}

export function createPostgresEventSink<E>(cfg: PostgresEventSinkConfig<E>): PostgresEventSink<E> {
  const pg = createPgPool(cfg.connectionString);

  const dbCols = cfg.columns.map(([db]) => db).join(", ");
  const insertSql = `INSERT INTO ${cfg.table}(${dbCols}, tenant_id) VALUES (${[...cfg.columns, null].map((_, i) => `$${i + 1}`).join(",")})`;
  const pendingWrites = new Set<Promise<unknown>>();
  const settleWrites = (): Promise<unknown[]> => Promise.all(pendingWrites);

  const toEvent = (r: Record<string, unknown>): E => {
    const out: Record<string, unknown> = {};
    for (const [db, js, , kind, required] of cfg.columns) {
      if (required || r[db] != null) out[js] = CONVERT[kind](r[db]);
    }
    return out as E;
  };

  function buildWhere(tenant: Tenant, opts: Record<string, unknown>): { where: string; params: unknown[] } {
    const conds: string[] = ["tenant_id = $1"];
    const params: unknown[] = [tenant.id];
    for (const [opt, db] of Object.entries(cfg.equalityFilters)) {
      if (opts[opt] === undefined) continue;
      params.push(opts[opt]);
      conds.push(`${db} = $${params.length}`);
    }
    if (opts.since !== undefined) {
      params.push(opts.since);
      conds.push(`ts >= $${params.length}`);
    }
    return { where: `WHERE ${conds.join(" AND ")}`, params };
  }

  return {
    forTenant: pg.forTenant,
    record(tenant, input) {
      const s = input as Record<string, unknown>;
      const values = [...cfg.columns.map(([, js]) => (js === "ts" ? Date.now() : (s[js] ?? null))), tenant.id];
      const write = pg
        .forTenant(tenant)
        .q(insertSql, values)
        .catch(reportFailureAs(cfg.persistErrorMessage, undefined))
        .finally(() => pendingWrites.delete(write));
      pendingWrites.add(write);
    },
    async flush() {
      await settleWrites();
    },
    async list(tenant, input = {}) {
      await settleWrites();
      const opts = input as Record<string, unknown>;
      const { where, params } = buildWhere(tenant, opts);
      params.push(opts.limit ?? cfg.defaultLimit);
      params.push(opts.offset ?? 0);
      const rows = await pg
        .forTenant(tenant)
        .q(
          `SELECT ${dbCols} FROM ${cfg.table} ${where} ORDER BY ts DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        );
      return rows.map(toEvent);
    },
    async count(tenant, input = {}) {
      await settleWrites();
      const { where, params } = buildWhere(tenant, input as Record<string, unknown>);
      const rows = await pg.forTenant(tenant).q(`SELECT COUNT(*)::bigint AS total FROM ${cfg.table} ${where}`, params);
      return Number(rows[0]?.total ?? 0);
    },
  };
}
