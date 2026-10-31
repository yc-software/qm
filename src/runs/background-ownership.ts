import { keyedRows, type KeyedRows, type RowColumns } from "../persistence/keyed-rows.ts";

export interface BackgroundOwnership {
  ownerDeploymentId: string | null;
  setAt: string | null;
  setBy: string | null;
}

export interface BackgroundOwnershipChange {
  ownerDeploymentId: string | null;
  expectedOwnerDeploymentId?: string | null;
  setBy: string;
}

export class BackgroundOwnershipConflict extends Error {}

const COLUMNS: RowColumns<BackgroundOwnership, "id"> = {
  id: "text",
  ownerDeploymentId: "text",
  setAt: "text",
  setBy: "text",
};

const OWNED = `json ? 'ownerDeploymentId' AND (NOT json ? 'desiredDeploymentId'
  OR json->'desiredDeploymentId' = json->'ownerDeploymentId')`;

const BACKGROUND_OWNERSHIP_MIGRATION = {
  id: "tenancy/background_ownership/0001-typed",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `CREATE TABLE IF NOT EXISTS background_ownership(id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
    `ALTER TABLE background_ownership RENAME TO background_ownership_kv`,
    `ALTER INDEX background_ownership_pkey RENAME TO background_ownership_kv_pkey`,
    `CREATE TABLE background_ownership(
       id TEXT PRIMARY KEY,
       owner_deployment_id TEXT,
       set_at TEXT,
       set_by TEXT
     )`,
    `INSERT INTO background_ownership(id, owner_deployment_id, set_at, set_by)
       SELECT id,
              CASE WHEN ${OWNED} THEN json->>'ownerDeploymentId'
                   WHEN json->>'enabled' = 'true' THEN json->>'desiredDeploymentId' END,
              CASE WHEN ${OWNED} THEN json->>'setAt' END,
              CASE WHEN ${OWNED} THEN json->>'setBy' END
         FROM background_ownership_kv`,
    `DROP TABLE background_ownership_kv`,
    `DO $drop_version$ BEGIN
       IF to_regclass('durable_map_versions') IS NOT NULL THEN
         DELETE FROM durable_map_versions WHERE tbl = 'background_ownership';
       END IF;
     END $drop_version$`,
  ],
};

export function createBackgroundOwnershipRows(databaseUrl: string | undefined): KeyedRows<BackgroundOwnership> {
  return keyedRows(databaseUrl, {
    table: "background_ownership",
    key: "id",
    global: true,
    columns: COLUMNS,
    migrations: [BACKGROUND_OWNERSHIP_MIGRATION],
  });
}

const normalized = (value: Partial<BackgroundOwnership>): BackgroundOwnership => ({
  ownerDeploymentId: value.ownerDeploymentId ?? null,
  setAt: value.setAt ?? null,
  setBy: value.setBy ?? null,
});

export function createBackgroundOwnershipStore(
  rows: Pick<KeyedRows<BackgroundOwnership>, "get" | "putIfAbsent" | "update">,
) {
  const key = "ownership";
  const ready = () => rows.putIfAbsent(key, normalized({}));
  return {
    async get(): Promise<BackgroundOwnership> {
      return normalized((await rows.get(key)) ?? (await ready()));
    },
    async set(change: BackgroundOwnershipChange): Promise<BackgroundOwnership> {
      await ready();
      const result = await rows.update(key, (stored) => {
        const current = normalized(stored);
        if (
          change.expectedOwnerDeploymentId !== undefined &&
          current.ownerDeploymentId !== change.expectedOwnerDeploymentId &&
          current.ownerDeploymentId !== change.ownerDeploymentId
        )
          throw new BackgroundOwnershipConflict("Background owner changed");
        if (current.ownerDeploymentId === change.ownerDeploymentId) return stored;
        return { ownerDeploymentId: change.ownerDeploymentId, setAt: new Date().toISOString(), setBy: change.setBy };
      });
      if (!result) throw new Error("Background ownership disappeared");
      return normalized(result);
    },
  };
}

export type BackgroundOwnershipStore = ReturnType<typeof createBackgroundOwnershipStore>;

export interface BackgroundOwnershipControl {
  store: BackgroundOwnershipStore;
  instanceId: string;
  deploymentId: string;
  active: () => boolean;
}
