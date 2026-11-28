import { createPgPool } from "../persistence/pg-pool.ts";
import type { Tenant } from "../tenants/context.ts";

interface AppThumbnail {
  version: number;
  image: Buffer;
}

export interface AppThumbnailStore {
  save(tenant: Tenant, deploymentId: string, thumbnail: AppThumbnail): Promise<void>;
  open(tenant: Tenant, deploymentId: string): Promise<AppThumbnail | null>;
  versions(tenant: Tenant, deploymentIds: string[]): Promise<Map<string, number>>;
}

export function createPostgresAppThumbnailStore(connectionString: string): AppThumbnailStore {
  const pg = createPgPool(connectionString);
  return {
    async save(tenant, deploymentId, { version, image }) {
      await pg.forTenant(tenant).q(
        `INSERT INTO app_thumbnails(tenant_id, deployment_id, version, image, captured_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, deployment_id)
         DO UPDATE SET version = EXCLUDED.version, image = EXCLUDED.image, captured_at = EXCLUDED.captured_at`,
        [tenant.id, deploymentId, version, image, Date.now()],
      );
    },
    async open(tenant, deploymentId) {
      const [row] = await pg
        .forTenant(tenant)
        .q(`SELECT version, image FROM app_thumbnails WHERE tenant_id = $1 AND deployment_id = $2`, [
          tenant.id,
          deploymentId,
        ]);
      return row ? { version: Number(row.version), image: row.image as Buffer } : null;
    },
    async versions(tenant, deploymentIds) {
      const rows = await pg
        .forTenant(tenant)
        .q(
          `SELECT deployment_id, version FROM app_thumbnails WHERE tenant_id = $1 AND deployment_id = ANY($2::text[])`,
          [tenant.id, deploymentIds],
        );
      return new Map(rows.map((r) => [String(r.deployment_id), Number(r.version)]));
    },
  };
}
