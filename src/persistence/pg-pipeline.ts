import type { Connection, PoolClient, QueryConfig, QueryResult, Submittable } from "pg";

export type PgSetting = readonly [name: string, value: string];

type QueryCallback = (error: Error | undefined, result: QueryResult) => void;

interface PgQueryProtocol extends Submittable {
  submit(connection: Connection): Error | null;
  handleDataRow(message: unknown): void;
  handleCommandComplete(message: unknown, connection: Connection): void;
}

type PgQueryConstructor = new (
  config: QueryConfig & { queryMode: "extended"; callback: QueryCallback },
) => PgQueryProtocol;

function definePipelinedQuery(Query: PgQueryConstructor) {
  return class PipelinedQuery extends Query {
    private readonly settings: readonly PgSetting[];
    private prefixPending = true;

    constructor(settings: readonly PgSetting[], text: string, values: unknown[], callback: QueryCallback) {
      super({ text, values, queryMode: "extended", callback });
      this.settings = settings;
    }

    override submit(connection: Connection): Error | null {
      connection.stream.cork();
      try {
        connection.parse({ name: "", text: settingsSql(this.settings.length), types: [] }, true);
        connection.bind({ values: this.settings.flat() }, true);
        connection.execute({}, true);
        return super.submit(connection);
      } finally {
        connection.stream.uncork();
      }
    }

    override handleDataRow(message: unknown): void {
      if (!this.prefixPending) super.handleDataRow(message);
    }

    override handleCommandComplete(message: unknown, connection: Connection): void {
      if (this.prefixPending) this.prefixPending = false;
      else super.handleCommandComplete(message, connection);
    }
  };
}

let pipelinedQueryClass: Promise<ReturnType<typeof definePipelinedQuery>> | undefined;

function settingsSql(count: number): string {
  return `SELECT ${Array.from({ length: count }, (_, i) => `set_config($${2 * i + 1}, $${2 * i + 2}, true)`).join(", ")}`;
}

export async function pipelinedQuery(
  client: PoolClient,
  settings: readonly PgSetting[],
  text: string,
  values: unknown[],
): Promise<QueryResult> {
  if (!settings.length) return client.query({ text, values });
  const PipelinedQuery = await (pipelinedQueryClass ??= import("pg").then(({ default: pg }) =>
    definePipelinedQuery(pg.Query as unknown as PgQueryConstructor),
  ));
  return new Promise((resolve, reject) => {
    client.query(
      new PipelinedQuery(settings, text, values, (error, result) => (error ? reject(error) : resolve(result))),
    );
  });
}
