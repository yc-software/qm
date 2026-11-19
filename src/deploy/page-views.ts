import { createPgPool } from "../persistence/pg-pool.ts";
import type { Tenant } from "../tenants/context.ts";

export const NAME_INDEX = "deployments_name_unique";

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
  lastViews(tenant: Tenant, viewer: string, appIds: string[]): Promise<Map<string, number>>;
}

const MAX_PATH = 2048;
const MAX_USER_AGENT = 512;
const MAX_IP = 64;
const MAX_IN_FLIGHT = 32;
const DROP_REPORT_INTERVAL_MS = 60_000;

const clip = (value: string | null, max: number): string | null => (value === null ? null : value.slice(0, max));

export function createPostgresAppPageViewLog(connectionString: string): AppPageViewLog {
  const pg = createPgPool(connectionString);
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
        await pg.q(
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
    async lastViews(tenant, viewer, appIds) {
      const rows = await pg.forTenant(tenant).q(
        `SELECT d.id AS deployment_id, v.at FROM unnest($3::text[]) AS d(id)
           CROSS JOIN LATERAL (SELECT at FROM app_page_views
             WHERE tenant_id = $1 AND viewer = $2 AND deployment_id = d.id ORDER BY at DESC LIMIT 1) v`,
        [tenant.id, viewer, appIds],
      );
      return new Map(rows.map((r) => [String(r.deployment_id), Number(r.at)]));
    },
  };
}
