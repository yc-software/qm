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
  handleDataRow(message: unknown): void;
  handleCommandComplete(message: unknown, connection: Connection): void;
  handleReadyForQuery(connection: Connection): void;
}

interface Submittable {
  submit(connection: Connection): Error | null;
}

interface Queryable {
  query(config: unknown, values?: unknown, callback?: unknown): unknown;
}

interface ClientInternals extends Queryable {
  transactionTenant?: string;
  getTransactionStatus(): string | null;
}

const BIND_TENANT = "SELECT set_config('qm.tenant_id', $1, true)";

const submittableTenants = new WeakMap<Submittable, string>();

function guardSubmittable(client: ClientInternals, config: Submittable, tenant: string | undefined): void {
  if (!tenant) return;
  const submit = config.submit.bind(config);
  config.submit = (connection) =>
    client.getTransactionStatus() === "T" && client.transactionTenant === tenant
      ? submit(connection)
      : new Error("Streaming queries for a tenant must run inside a transaction bound to that tenant");
}

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
    binding = false;
    readonly tenant: string | undefined;
    constructor(tenant: string | undefined, config: unknown, values?: unknown) {
      super(config, values);
      this.tenant = tenant;
    }
    override submit(connection: Connection): Error | null {
      const client = this.client;
      const status = client?.getTransactionStatus();
      const idle = status === "I";
      if (client && idle) client.transactionTenant = this.tenant;
      if (this.tenant && !idle && client?.transactionTenant && client.transactionTenant !== this.tenant) {
        return new Error("This transaction is bound to another tenant");
      }
      const unboundTransaction = status === "T" && !client?.transactionTenant;
      this.bound = Boolean(this.tenant) && typeof this.text === "string" && (idle || unboundTransaction);
      if (this.bound && client && unboundTransaction) client.transactionTenant = this.tenant;
      this.binding = this.bound;
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
    override handleDataRow(message: unknown): void {
      if (!this.binding) super.handleDataRow(message);
    }
    override handleCommandComplete(message: unknown, connection: Connection): void {
      if (!this.binding) return super.handleCommandComplete(message, connection);
      this.binding = false;
      const rows = this.rows;
      this.rows = undefined;
      super.handleCommandComplete(message, connection);
      this.rows = rows;
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
      if (!plainQuery(config)) {
        guardSubmittable(this, config as Submittable, submittableTenants.get(config as Submittable) ?? boundTenant());
        return super.query(config, values, callback);
      }
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
      if (!plainQuery(config)) {
        const tenant = boundTenant();
        if (tenant) submittableTenants.set(config as Submittable, tenant);
        return super.query(config, values, callback);
      }
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
