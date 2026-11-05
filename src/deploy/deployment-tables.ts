import { durableMapTenancy } from "../persistence/durable-map.ts";
import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

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
];
