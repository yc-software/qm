import type { Connection, PoolConfig } from "pg";
import { boundTenant } from "./context.ts";

type PgModule = typeof import("pg").default;
type PgPoolInstance = InstanceType<PgModule["Pool"]>;
type Callback = (error: Error | null | undefined, result?: unknown) => void;

interface QueryInternals {
  text?: string;
  rows?: number;
  callback?: Callback;
  _results: unknown;
  requiresPreparation(): boolean;
  prepare(connection: Connection): void;
  submit(connection: Connection): Error | null;
  handleReadyForQuery(connection: Connection): void;
}

interface Queryable {
  query(config: unknown, values?: unknown, callback?: unknown): unknown;
}

interface ClientInternals extends Queryable {
  transactionTenant?: string;
  getTransactionStatus(): string | null;
}

const BIND_TENANT = "SELECT set_config('qm.tenant_id', $1, true)";

function plainQuery(config: unknown): boolean {
  return typeof config === "string" || (typeof config === "object" && config !== null && !("submit" in config));
}

function tenantPgPoolClass(pg: PgModule): new (config: PoolConfig) => PgPoolInstance {
  const BaseQuery = pg.Query as unknown as new (config: unknown, values?: unknown) => QueryInternals;
  const BaseClient = pg.Client as unknown as new (config: unknown) => ClientInternals;
  const BasePool = pg.Pool as unknown as new (config: unknown) => Queryable;

  class TenantQuery extends BaseQuery {
    client: ClientInternals | undefined;
    bound = false;
    readonly tenant: string | undefined;
    constructor(tenant: string | undefined, config: unknown, values?: unknown) {
      super(config, values);
      this.tenant = tenant;
    }
    override submit(connection: Connection): Error | null {
      const idle = this.client?.getTransactionStatus() === "I";
      if (this.client && idle) this.client.transactionTenant = this.tenant;
      if (this.tenant && !idle && this.client?.transactionTenant && this.client.transactionTenant !== this.tenant) {
        return new Error("This transaction is bound to another tenant");
      }
      this.bound = Boolean(this.tenant) && idle && !this.rows && typeof this.text === "string";
      if (!this.bound || this.requiresPreparation()) return super.submit(connection);
      connection.query(`SELECT set_config('qm.tenant_id', '${this.tenant}', true);${this.text}`);
      return null;
    }
    override prepare(connection: Connection): void {
      if (this.bound) {
        connection.parse({ text: BIND_TENANT, name: "", types: [] }, false);
        connection.bind({ portal: "", statement: "", values: [this.tenant] }, false);
        connection.describe({ type: "P", name: "" }, false);
        connection.execute({ portal: "" }, false);
      }
      super.prepare(connection);
    }
    override handleReadyForQuery(connection: Connection): void {
      if (this.bound && Array.isArray(this._results)) {
        this._results.shift();
        if (this._results.length === 1) this._results = this._results[0];
      }
      super.handleReadyForQuery(connection);
    }
  }

  class TenantClient extends BaseClient {
    override query(config: unknown, values?: unknown, callback?: unknown): unknown {
      if (config instanceof TenantQuery) {
        config.client = this;
        return super.query(config, values, callback);
      }
      if (!plainQuery(config)) return super.query(config, values, callback);
      const done = (typeof values === "function" ? values : callback) as Callback | undefined;
      const query = new TenantQuery(boundTenant(), config, typeof values === "function" ? undefined : values);
      query.client = this;
      if (done) {
        query.callback = done;
        super.query(query);
        return undefined;
      }
      return new Promise((resolve, reject) => {
        query.callback = (error, result) => (error ? reject(error) : resolve(result));
        super.query(query);
      });
    }
  }

  class TenantPool extends BasePool {
    constructor(config: PoolConfig) {
      super({ ...config, Client: TenantClient });
    }
    override query(config: unknown, values?: unknown, callback?: unknown): unknown {
      if (!plainQuery(config)) return super.query(config, values, callback);
      const done = typeof values === "function" ? values : callback;
      const query = new TenantQuery(boundTenant(), config, typeof values === "function" ? undefined : values);
      return done ? super.query(query, done) : super.query(query);
    }
  }

  return TenantPool as unknown as new (config: PoolConfig) => PgPoolInstance;
}

let TenantPool: ReturnType<typeof tenantPgPoolClass> | undefined;

export function tenantPgPool(pg: PgModule, config: PoolConfig): PgPoolInstance {
  TenantPool ??= tenantPgPoolClass(pg);
  return new TenantPool(config);
}
