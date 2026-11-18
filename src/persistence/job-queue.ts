import { PgBoss, type ConstructorOptions } from "pg-boss";
import pgBossPackage from "pg-boss/package.json" with { type: "json" };
import type { PgPool } from "./pg-pool.ts";

export function poolBoss(pg: () => PgPool, options: Omit<ConstructorOptions, "db">): PgBoss {
  return new PgBoss({
    ...options,
    db: { executeSql: async (text, values) => (await pg().pool()).query(text, values) },
  });
}

class JobQueueNotInstalled extends Error {}

export async function assertJobQueueInstalled(boss: PgBoss, schema: string): Promise<void> {
  const installed = (await boss.isInstalled()) ? await boss.schemaVersion() : null;
  if (installed !== pgBossPackage.pgboss.schema)
    throw new JobQueueNotInstalled(
      `job queue schema ${schema} is at version ${installed ?? "none"}, expected ${pgBossPackage.pgboss.schema}`,
    );
}

export function jobQueueMisconfigured(error: unknown): boolean {
  return error instanceof JobQueueNotInstalled || (error as { code?: unknown } | null)?.code === "42501";
}
