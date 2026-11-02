import type { PgPool } from "../src/persistence/pg-pool.ts";

export function makeRewriter(mapping: Record<string, string>): {
  rewriteString: (s: string) => string;
  rewriteJson: (v: unknown) => unknown;
};

export function mergeDirs(src: string, dst: string): string[];

export function runMigration(opts: {
  pool: PgPool;
  mapping: Record<string, string>;
  apply: boolean;
  rewriteHistory?: boolean;
  dataDir?: string;
  allowLive?: boolean;
  log?: (line: string) => void;
}): Promise<{ problems: string[] }>;
