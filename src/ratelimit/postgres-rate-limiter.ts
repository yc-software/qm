import { createPgPool } from "../persistence/pg-pool.ts";
import type { RateLimiter } from "./rate-limiter.ts";

export function createPostgresRateLimiter(
  connectionString: string,
  opts: { maxPerWindow: number; windowMs: number },
): RateLimiter {
  const { q } = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS rate_limit_windows(
      principal_id TEXT PRIMARY KEY,
      window_start BIGINT NOT NULL,
      count INTEGER NOT NULL
    )`,
  ]);
  return {
    async check(principalId) {
      const now = Date.now();
      const rows = await q(
        `INSERT INTO rate_limit_windows(principal_id, window_start, count) VALUES ($1, $2, 1)
         ON CONFLICT (principal_id) DO UPDATE SET
           count = CASE WHEN $2 - rate_limit_windows.window_start >= $3 THEN 1 ELSE rate_limit_windows.count + 1 END,
           window_start = CASE WHEN $2 - rate_limit_windows.window_start >= $3 THEN $2 ELSE rate_limit_windows.window_start END
         RETURNING window_start, count`,
        [principalId, now, opts.windowMs],
      );
      const start = Number(rows[0]?.window_start ?? now);
      const count = Number(rows[0]?.count ?? 1);
      return count <= opts.maxPerWindow
        ? { allowed: true }
        : { allowed: false, retryAfterMs: Math.max(0, opts.windowMs - (now - start)) };
    },
  };
}
