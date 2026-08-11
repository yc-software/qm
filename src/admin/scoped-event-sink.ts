import type { ScopeId } from "../types.ts";
import { createPgPool, type PgPool } from "../persistence/pg-pool.ts";

export interface ScopedEvent {
  scopeLabel: ScopeId;
}

interface ScopedEventQuery<E> {
  scopeId?: string;
  limit?: number;
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
        .slice(-limit)
        .reverse();
    },
    all: () => events,
  };
}

type TimestampedQuery = { scopeId?: string; since?: number; limit?: number; [k: string]: unknown };

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
  extraSchemaStatements?: string[];
  defaultLimit: number;
  equalityFilters: Record<string, string>;
  persistErrorMessage: string;
}

export interface PostgresEventSink<E> {
  q: PgPool["q"];
  record(input: Omit<E, "ts">): void;
  flush(): Promise<void>;
  list(opts?: object): Promise<E[]>;
  count(opts?: object): Promise<number>;
}

function standardIndexes(table: string): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS ${table}_by_ts ON ${table}(ts DESC)`,
    `CREATE INDEX IF NOT EXISTS ${table}_by_scope_ts ON ${table}(scope_label, ts DESC)`,
  ];
}

export function createPostgresEventSink<E>(cfg: PostgresEventSinkConfig<E>): PostgresEventSink<E> {
  const createTable = [
    `CREATE TABLE IF NOT EXISTS ${cfg.table}(`,
    [
      "  id BIGSERIAL PRIMARY KEY",
      ...cfg.columns.map(([db, , sqlType, , required]) => `  ${db} ${sqlType}${required ? " NOT NULL" : ""}`),
    ].join(",\n"),
    ")",
  ].join("\n");
  const { q } = createPgPool(cfg.connectionString, [
    createTable,
    ...(cfg.extraSchemaStatements ?? standardIndexes(cfg.table)),
  ]);

  const dbCols = cfg.columns.map(([db]) => db).join(", ");
  const insertSql = `INSERT INTO ${cfg.table}(${dbCols}) VALUES (${cfg.columns.map((_, i) => `$${i + 1}`).join(",")})`;
  const pendingWrites = new Set<Promise<unknown>>();
  const settleWrites = (): Promise<unknown[]> => Promise.all(pendingWrites);

  const toEvent = (r: Record<string, unknown>): E => {
    const out: Record<string, unknown> = {};
    for (const [db, js, , kind, required] of cfg.columns) {
      if (required || r[db] != null) out[js] = CONVERT[kind](r[db]);
    }
    return out as E;
  };

  function buildWhere(opts: Record<string, unknown>): { where: string; params: unknown[] } {
    const conds: string[] = [];
    const params: unknown[] = [];
    for (const [opt, db] of Object.entries(cfg.equalityFilters)) {
      if (opts[opt] === undefined) continue;
      params.push(opts[opt]);
      conds.push(`${db} = $${params.length}`);
    }
    if (opts.since !== undefined) {
      params.push(opts.since);
      conds.push(`ts >= $${params.length}`);
    }
    return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
  }

  return {
    q,
    record(input) {
      const s = input as Record<string, unknown>;
      const values = cfg.columns.map(([, js]) => (js === "ts" ? Date.now() : (s[js] ?? null)));
      const write = q(insertSql, values)
        .catch((err) => console.error(cfg.persistErrorMessage, err))
        .finally(() => pendingWrites.delete(write));
      pendingWrites.add(write);
    },
    async flush() {
      await settleWrites();
    },
    async list(input = {}) {
      await settleWrites();
      const opts = input as Record<string, unknown>;
      const { where, params } = buildWhere(opts);
      params.push(opts.limit ?? cfg.defaultLimit);
      const rows = await q(
        `SELECT ${dbCols} FROM ${cfg.table} ${where} ORDER BY ts DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(toEvent);
    },
    async count(input = {}) {
      await settleWrites();
      const { where, params } = buildWhere(input as Record<string, unknown>);
      const rows = await q(`SELECT COUNT(*)::bigint AS total FROM ${cfg.table} ${where}`, params);
      return Number(rows[0]?.total ?? 0);
    },
  };
}
