import type { TestContext } from "node:test";
import { createPgPool } from "../../src/persistence/pg-pool.ts";

export interface PgStatement {
  text: string;
  values: unknown[];
}

type Step = (statement: PgStatement, run: () => Promise<unknown>) => Promise<unknown>;

type Unsafe = (text: string, params?: unknown[], options?: unknown) => Promise<unknown>;

interface Queryable {
  unsafe: Unsafe;
  begin: (fn: (tx: Queryable) => Promise<unknown>) => Promise<unknown>;
}

function intercepted(target: Queryable, unsafe: Unsafe, step: Step): Unsafe {
  return (text, params = [], options) => {
    const run = () => unsafe.call(target, text, params, options);
    if (options && typeof options === "object" && "onexecute" in options) return run();
    return step({ text, values: params.map((value) => (value as { value?: unknown } | null)?.value ?? value) }, run);
  };
}

export async function interceptPg(t: TestContext, url: string, step: Step): Promise<void> {
  const handle = createPgPool(url);
  t.after(() => handle.close());
  const sql = (await handle.pool()) as unknown as Queryable;
  const unsafe = sql.unsafe;
  const begin = sql.begin;
  t.mock.method(sql, "unsafe", intercepted(sql, unsafe, step));
  t.mock.method(sql, "begin", (fn: (tx: Queryable) => Promise<unknown>) =>
    step({ text: "BEGIN", values: [] }, () =>
      begin.call(sql, async (tx) => {
        Object.assign(tx, { unsafe: intercepted(tx, tx.unsafe, step) });
        const result = await fn(tx);
        await step({ text: "COMMIT", values: [] }, async () => undefined);
        return result;
      }),
    ),
  );
}
