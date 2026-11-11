import { durableMapTenancy } from "../persistence/durable-map.ts";
import { inboundIndexes } from "../tenants/lookup.ts";
import { createPgPool, type PgMigrationDefinition } from "../persistence/pg-pool.ts";
import type { Tenant } from "../tenants/context.ts";

export const NAME_INDEX = "deployments_name_unique";

const ACCESS_TABLE: PgMigrationDefinition = {
  id: "deploy/access/0001",
  statements: [
    "CREATE TABLE IF NOT EXISTS deployments (id TEXT PRIMARY KEY, json JSONB NOT NULL)",
    `CREATE TABLE IF NOT EXISTS deployment_access (
        id TEXT PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
        last_access_at BIGINT NOT NULL
      )`,
  ],
};

const APP_PAGE_VIEWS_TABLE: PgMigrationDefinition = {
  id: "deploy/app-page-views/0001",
  statements: [
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
  ],
};

export const DEPLOYMENT_TABLES: PgMigrationDefinition[] = [
  ACCESS_TABLE,
  APP_PAGE_VIEWS_TABLE,
  ...durableMapTenancy("deployments", {
    tables: [
      { table: "deployment_access", primaryKey: "id" },
      { table: "app_page_views", primaryKey: "id" },
    ],
    references: [
      {
        table: "deployment_access",
        name: "deployment_access_id_fkey",
        columns: "id",
        references: "deployments(tenant_id, id)",
        onDelete: "CASCADE",
      },
      {
        table: "app_page_views",
        name: "app_page_views_deployment_id_fkey",
        columns: "deployment_id",
        references: "deployments(tenant_id, id)",
      },
    ],
    after: [`DROP INDEX IF EXISTS ${NAME_INDEX}`],
  }),
  {
    id: "durable-map/deployments/0020-name-index",
    statements: [
      `DO $name_index$ BEGIN
        IF EXISTS (
          SELECT 1 FROM deployments WHERE json->>'name' IS NOT NULL
           GROUP BY tenant_id, json->>'name' HAVING count(*) > 1
        ) THEN
          RAISE WARNING 'deployments has duplicate names within a tenant; ${NAME_INDEX} was not created';
        ELSE
          CREATE UNIQUE INDEX IF NOT EXISTS ${NAME_INDEX}
            ON deployments (tenant_id, (json->>'name')) WHERE json->>'name' IS NOT NULL;
        END IF;
      END $name_index$`,
    ],
  },
  inboundIndexes("deployments", ["name"]),
  {
    id: "durable-map/deployments/0030-page-views-by-viewer",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS app_page_views_by_viewer ON app_page_views(tenant_id, viewer, deployment_id, at DESC)`,
    ],
  },
];

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
  lastViews(tenant: Tenant, viewer: string): Promise<Map<string, number>>;
}

const MAX_PATH = 2048;
const MAX_USER_AGENT = 512;
const MAX_IP = 64;
const MAX_IN_FLIGHT = 32;
const DROP_REPORT_INTERVAL_MS = 60_000;

const clip = (value: string | null, max: number): string | null => (value === null ? null : value.slice(0, max));

export function createPostgresAppPageViewLog(connectionString: string): AppPageViewLog {
  const pg = createPgPool(connectionString, DEPLOYMENT_TABLES);
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
    async lastViews(tenant, viewer) {
      const rows = await pg
        .forTenant(tenant)
        .q(
          "SELECT deployment_id, max(at) AS at FROM app_page_views WHERE tenant_id = $1 AND viewer = $2 GROUP BY deployment_id",
          [tenant.id, viewer],
        );
      return new Map(rows.map((r) => [String(r.deployment_id), Number(r.at)]));
    },
  };
}
