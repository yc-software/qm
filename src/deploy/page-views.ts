import { createPgPool } from "../persistence/pg-pool.ts";

export type AppViewAuthMode = "signed_in" | "public" | "app_only";

export interface AppPageView {
  deploymentId: string;
  version: number | null;
  viewer: string | null;
  authMode: AppViewAuthMode;
  at: number;
  path: string;
  ip: string | null;
  userAgent: string | null;
}

export interface AppPageViewLog {
  record(view: AppPageView): Promise<void>;
}

const MAX_PATH = 2048;
const MAX_USER_AGENT = 512;
const MAX_IP = 64;
const MAX_IN_FLIGHT = 32;
const DROP_REPORT_INTERVAL_MS = 60_000;

const clip = (value: string | null, max: number): string | null => (value === null ? null : value.slice(0, max));

export function createPostgresAppPageViewLog(connectionString: string): AppPageViewLog {
  const { q } = createPgPool(connectionString, "deploy/app-page-views/0001", [
    "CREATE TABLE IF NOT EXISTS deployments (id TEXT PRIMARY KEY, json JSONB NOT NULL)",
    `CREATE TABLE IF NOT EXISTS app_page_views(
      id BIGSERIAL PRIMARY KEY,
      deployment_id TEXT NOT NULL REFERENCES deployments(id),
      version INTEGER,
      viewer TEXT,
      auth_mode TEXT NOT NULL,
      at BIGINT NOT NULL,
      path TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS app_page_views_by_deployment_at ON app_page_views(deployment_id, at DESC)`,
    `CREATE INDEX IF NOT EXISTS app_page_views_by_at ON app_page_views(at)`,
  ]);
  let inFlight = 0;
  let dropped = 0;
  let lastDropReport = 0;
  return {
    async record(view) {
      if (inFlight >= MAX_IN_FLIGHT) {
        dropped++;
        const now = Date.now();
        if (now - lastDropReport < DROP_REPORT_INTERVAL_MS) return;
        lastDropReport = now;
        const count = dropped;
        dropped = 0;
        throw new Error(`dropped ${count} page views: write backlog full`);
      }
      inFlight++;
      try {
        await q(
          `INSERT INTO app_page_views(deployment_id, version, viewer, auth_mode, at, path, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            view.deploymentId,
            view.version,
            view.viewer,
            view.authMode,
            view.at,
            clip(view.path, MAX_PATH),
            clip(view.ip, MAX_IP),
            clip(view.userAgent, MAX_USER_AGENT),
          ],
        );
      } finally {
        inFlight--;
      }
    },
  };
}
