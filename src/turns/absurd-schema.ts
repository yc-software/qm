import { readFileSync } from "node:fs";
import { createPgPool, type PgMigrationDefinition, type PgPool } from "../persistence/pg-pool.ts";

export const TURN_QUEUES = ["turns_people", "turns_delegated", "turns_background"] as const;
export type TurnQueue = (typeof TURN_QUEUES)[number];
export const JOB_QUEUE = "jobs";
export type AbsurdQueue = TurnQueue | typeof JOB_QUEUE;
export const ABSURD_QUEUES: readonly AbsurdQueue[] = [...TURN_QUEUES, JOB_QUEUE];

export const ABSURD_SQL_URL = new URL("./absurd.sql", import.meta.url);

export const ABSURD_RETENTION_DAYS = 7;

const queueSetup = (queue: string): string[] => [
  `SELECT absurd.create_queue('${queue}', 'unpartitioned')`,
  `SELECT absurd.set_queue_policy('${queue}', '{"cleanup_ttl":"${ABSURD_RETENTION_DAYS} days"}'::jsonb)`,
];

export const ABSURD_MIGRATION: PgMigrationDefinition = {
  id: "absurd/0001",
  script: true,
  statements: [readFileSync(ABSURD_SQL_URL, "utf8"), ...ABSURD_QUEUES.flatMap(queueSetup)],
  expectedChecksum: "988142617a349f0a4194f9f3d5d3be38519f040183776e4971952fea5726e985",
};

export function registerAbsurdSchema(connectionString: string): PgPool {
  return createPgPool(connectionString, [ABSURD_MIGRATION]);
}
