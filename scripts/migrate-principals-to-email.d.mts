import type { Pool } from "pg";

export function makeRewriter(mapping: Record<string, string>): {
  rewriteString: (s: string) => string;
  rewriteJson: (v: unknown) => unknown;
};

export function runMigration(opts: {
  pool: Pool;
  mapping: Record<string, string>;
  apply: boolean;
  rewriteHistory?: boolean;
  allowLive?: boolean;
  log?: (line: string) => void;
}): Promise<{ problems: string[] }>;
