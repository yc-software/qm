import { createHash, randomBytes } from "node:crypto";
import { createPgPool } from "../persistence/pg-pool.ts";

interface BrokerSession {
  email: string;
  authTime: number;
  expiresAtMs: number;
}

export interface BrokerSessionStore {
  create(email: string, idleS: number, absoluteS: number): Promise<BrokerSession & { token: string }>;
  use(token: string): Promise<BrokerSession | null>;
  revoke(email: string): Promise<void>;
}

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

export function createPostgresBrokerSessions(connectionString: string): BrokerSessionStore {
  const pg = createPgPool(connectionString);
  const session = (row: Record<string, unknown>): BrokerSession => ({
    email: String(row.email),
    authTime: Math.floor(new Date(String(row.authenticated_at)).getTime() / 1000),
    expiresAtMs: new Date(String(row.expires_at)).getTime(),
  });
  return {
    async create(email, idleS, absoluteS) {
      const token = randomBytes(32).toString("base64url");
      await pg.query("DELETE FROM auth_broker_sessions WHERE expires_at <= now()");
      const result = await pg.query(
        `INSERT INTO auth_broker_sessions (token_hash, email, expires_at, absolute_expires_at, idle_seconds)
         VALUES ($1, $2, now() + $3 * interval '1 second', now() + $4 * interval '1 second', $3)
         RETURNING email, authenticated_at, expires_at`,
        [hash(token), email, Math.min(idleS, absoluteS), absoluteS],
      );
      return { ...session(result.rows[0]!), token };
    },
    async use(token) {
      const result = await pg.query(
        `UPDATE auth_broker_sessions
         SET expires_at = LEAST(absolute_expires_at, now() + idle_seconds * interval '1 second')
         WHERE token_hash = $1 AND expires_at > now() AND absolute_expires_at > now()
         RETURNING email, authenticated_at, expires_at`,
        [hash(token)],
      );
      return result.rows[0] ? session(result.rows[0]) : null;
    },
    async revoke(email) {
      await pg.query("DELETE FROM auth_broker_sessions WHERE email = $1", [email]);
    },
  };
}
