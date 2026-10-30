import {
  globalConversion,
  memoryRows,
  typedTable,
  type KeyedRows,
  type TableSpec,
} from "../persistence/typed-table.ts";

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

const BACKGROUND_OWNERSHIP: TableSpec<BackgroundOwnership> = {
  table: "background_ownership",
  global: true,
  columns: { ownerDeploymentId: "text", setAt: "text", setBy: "text" },
};

const OWNED = `json ? 'ownerDeploymentId' AND (NOT json ? 'desiredDeploymentId'
  OR json->'desiredDeploymentId' = json->'ownerDeploymentId')`;

const BACKGROUND_OWNERSHIP_MIGRATION = globalConversion(BACKGROUND_OWNERSHIP, {
  ownerDeploymentId: `CASE WHEN ${OWNED} THEN json->>'ownerDeploymentId'
    WHEN json->>'enabled' = 'true' THEN json->>'desiredDeploymentId' END`,
  setAt: `CASE WHEN ${OWNED} THEN json->>'setAt' END`,
  setBy: `CASE WHEN ${OWNED} THEN json->>'setBy' END`,
});

export function createBackgroundOwnershipRows(databaseUrl: string | undefined): KeyedRows<BackgroundOwnership> {
  return databaseUrl
    ? typedTable(databaseUrl, BACKGROUND_OWNERSHIP, BACKGROUND_OWNERSHIP_MIGRATION)
    : memoryRows<BackgroundOwnership>(true);
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
