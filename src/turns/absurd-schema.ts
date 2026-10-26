import { readFileSync } from "node:fs";
import { createPgPool, type PgMigrationDefinition, type PgPool } from "../persistence/pg-pool.ts";

export const TURN_QUEUES = ["turns_people", "turns_delegated", "turns_background"] as const;
export type TurnQueue = (typeof TURN_QUEUES)[number];

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  for (;;) {
    const end = sql.indexOf(quote, i);
    if (end < 0) throw new Error(`absurd-schema: unterminated ${quote} quote at offset ${start}`);
    if (sql[end + 1] !== quote) return end + 1;
    i = end + 2;
  }
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
    } else if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) throw new Error(`absurd-schema: unterminated block comment at offset ${i}`);
      i = end + 2;
    } else if (ch === "'" || ch === '"') {
      i = skipQuoted(sql, i, ch);
    } else if (ch === "$" && !IDENTIFIER_CHAR.test(sql[i - 1] ?? "")) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 64))?.[0];
      if (!tag) {
        i += 1;
        continue;
      }
      const end = sql.indexOf(tag, i + tag.length);
      if (end < 0) throw new Error(`absurd-schema: unterminated ${tag} body at offset ${i}`);
      i = end + tag.length;
    } else if (ch === ";") {
      statements.push(sql.slice(start, i + 1));
      start = i += 1;
    } else {
      i += 1;
    }
  }
  const tail = sql.slice(start);
  if (statements.length && !/\S/.test(tail.replace(/--[^\n]*/g, ""))) statements[statements.length - 1] += tail;
  else if (tail.trim()) statements.push(tail);
  return statements;
}

export const ABSURD_SQL_URL = new URL("./absurd.sql", import.meta.url);

export const ABSURD_MIGRATION: PgMigrationDefinition = {
  id: "absurd/0.5.1",
  statements: [
    ...splitSqlStatements(readFileSync(ABSURD_SQL_URL, "utf8")),
    ...TURN_QUEUES.flatMap((queue) => [
      `SELECT absurd.create_queue('${queue}', 'unpartitioned')`,
      `SELECT absurd.set_queue_policy('${queue}', '{"cleanup_ttl":"7 days"}'::jsonb)`,
    ]),
  ],
  expectedChecksum: "4f8dd2e6249339a7c89d650d4d71b5a04228cf329a45f515a834acdeca3864e9",
};

export function registerAbsurdSchema(connectionString: string): PgPool {
  return createPgPool(connectionString, [ABSURD_MIGRATION]);
}
