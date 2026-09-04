import type { SkillPackStore } from "./skill-pack-store.ts";
import type { SkillPackFetcher } from "./pack-fetcher.ts";
import { createNoopLeaderLease, type LeaderLease } from "../persistence/leader-lease.ts";
import { createSweeper } from "../util/sweeper.ts";
import { errMessage } from "../util/errors.ts";

const TICK_LEASE_KEY = "skills:sync:tick";
const DEFAULT_INTERVAL_MS = 300_000;

export interface SkillSyncEngine {
  tick(now?: number): Promise<void>;
  start(intervalMs: number): void;
  stop(): void;
}

export interface SkillSyncDeps {
  packs: SkillPackStore;
  fetcher: SkillPackFetcher;
  reconcile: (packId: string) => Promise<unknown>;
  leaderLease?: LeaderLease;
}

export function createSkillSyncEngine(deps: SkillSyncDeps): SkillSyncEngine {
  const leaderLease = deps.leaderLease ?? createNoopLeaderLease();

  async function syncOne(packId: string): Promise<void> {
    const pack = await deps.packs.get(packId);
    if (!pack) return;
    if (pack.syncMode === "tracked") {
      const head = await deps.fetcher.resolveRef(pack);
      if (pack.lastImport?.status === "ok" && head === pack.lastImport.commit) return;
      await deps.reconcile(packId);
    } else {
      const head = await deps.fetcher.resolveRef(pack);
      const available = pack.lastImport ? head !== pack.lastImport.commit : false;
      if (available !== Boolean(pack.updateAvailable)) {
        await deps.packs.update(packId, { updateAvailable: available });
      }
    }
  }

  async function syncAll(): Promise<void> {
    for (const pack of await deps.packs.list()) {
      try {
        await syncOne(pack.id);
      } catch (e) {
        console.error(`[skill-sync] pack ${pack.id} failed:`, errMessage(e));
      }
    }
  }

  const tick = async (): Promise<void> => {
    await leaderLease.hold(TICK_LEASE_KEY, syncAll);
  };

  const sweeper = createSweeper(
    () => tick().catch((e: unknown) => console.error("[skill-sync] tick failed:", errMessage(e))),
    DEFAULT_INTERVAL_MS,
    { label: "skill-sync" },
  );
  return { tick, start: sweeper.start, stop: sweeper.stop };
}
