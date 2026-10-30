import { createPgPool } from "../persistence/pg-pool.ts";
import type { TableSpec } from "../persistence/typed-table.ts";
import { TENANCY_BASE } from "../tenants/migrations.ts";
import type { FlyMachineConfig } from "./fly-deploy-provider.ts";

export const FLY_DEPLOY_CONFIGS: TableSpec<FlyMachineConfig> = {
  table: "fly_deploy_configs",
  key: "deploymentId",
  required: ["image", "env", "guest", "files", "services", "init"],
  columns: {
    image: "text",
    metadata: "jsonb",
    mounts: "jsonb",
    env: "jsonb",
    guest: "jsonb",
    files: "jsonb",
    services: "jsonb",
    init: "jsonb",
  },
};

export interface FlyPortClaims {
  claim(appName: string, port: number, deploymentId: string): Promise<string>;
}

const FLY_DEPLOY_PORTS = {
  id: "tenancy/fly_deploy_ports/0001-typed",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `CREATE TABLE IF NOT EXISTS fly_deploy_ports(id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
    `ALTER TABLE fly_deploy_ports RENAME TO fly_deploy_ports_kv`,
    `ALTER INDEX fly_deploy_ports_pkey RENAME TO fly_deploy_ports_kv_pkey`,
    `CREATE TABLE fly_deploy_ports(
       app_name TEXT NOT NULL,
       port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
       deployment_id TEXT NOT NULL,
       PRIMARY KEY (app_name, port)
     )`,
    `INSERT INTO fly_deploy_ports(app_name, port, deployment_id)
       SELECT substring(id FROM '^(.*):[0-9]+$'), substring(id FROM ':([0-9]+)$')::int, json #>> '{}'
         FROM fly_deploy_ports_kv`,
    `DROP TABLE fly_deploy_ports_kv`,
    `DO $drop_version$ BEGIN
       IF to_regclass('durable_map_versions') IS NOT NULL THEN
         DELETE FROM durable_map_versions WHERE tbl = 'fly_deploy_ports';
       END IF;
     END $drop_version$`,
  ],
};

export function createFlyPortClaims(databaseUrl: string | undefined): FlyPortClaims {
  if (!databaseUrl) {
    const owners = new Map<string, string>();
    return {
      async claim(appName, port, deploymentId) {
        const key = `${appName}:${port}`;
        if (!owners.has(key)) owners.set(key, deploymentId);
        return owners.get(key)!;
      },
    };
  }
  const db = createPgPool(databaseUrl, [TENANCY_BASE, FLY_DEPLOY_PORTS]);
  return {
    claim: async (appName, port, deploymentId) =>
      String(
        (
          await db.q(
            `INSERT INTO fly_deploy_ports(app_name, port, deployment_id) VALUES ($1, $2, $3)
             ON CONFLICT (app_name, port) DO UPDATE SET app_name = EXCLUDED.app_name RETURNING deployment_id`,
            [appName, port, deploymentId],
          )
        )[0]!.deployment_id,
      ),
  };
}
