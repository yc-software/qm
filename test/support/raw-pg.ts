import type { TestContext } from "node:test";
import { createPgPool, type PgPool } from "../../src/persistence/pg-pool.ts";

export interface RawPg extends Omit<PgPool, "query"> {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }>;
}

export function connectUnderMockTimers(context: TestContext): void {
  const flush = setInterval(() => {
    try {
      context.mock.timers.tick(0);
    } catch {
      clearInterval(flush);
    }
  }, 1);
  context.after(() => clearInterval(flush));
}

export function rawPg(url: string | undefined): RawPg {
  if (!url) throw new Error("DATABASE_URL is required");
  return createPgPool(url) as RawPg;
}
