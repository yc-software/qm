import type { SkillPack, SkillPackStore } from "./skill-pack-store.ts";
import type { SkillPackFetcher } from "./pack-fetcher.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import { createSweeper } from "../util/sweeper.ts";
import { claimThenBind } from "../tenants/claim.ts";
import { errMessage, reportFailureAs } from "../util/errors.ts";

const TICK_LEASE_KEY = "skills:sync:tick";
const DEFAULT_INTERVAL_MS = 300_000;

export interface SkillSyncEngine {
  tick(now?: number): Promise<void>;
  start(intervalMs: number): void;
  stop(): Promise<void>;
}

export interface SkillSyncDeps {
  packs: SkillPackStore;
  fetcher: SkillPackFetcher;
  reconcile: (packId: string) => Promise<unknown>;
  leaderLease: LeaderLease;
}

export function createSkillSyncEngine(deps: SkillSyncDeps): SkillSyncEngine {
  const leaderLease = deps.leaderLease;

  async function syncOne(pack: SkillPack): Promise<void> {
    if (pack.syncMode === "tracked") {
      const head = await deps.fetcher.resolveRef(pack);
      if (pack.lastImport?.status === "ok" && head === pack.lastImport.commit) return;
      await deps.reconcile(pack.id);
    } else {
      const head = await deps.fetcher.resolveRef(pack);
      const available = pack.lastImport ? head !== pack.lastImport.commit : false;
      if (available !== Boolean(pack.updateAvailable)) {
        await deps.packs.update(pack.id, { updateAvailable: available });
      }
    }
  }

  async function syncAll(): Promise<void> {
    await claimThenBind(deps.packs.claimTenants, async () => {
      for (const pack of await deps.packs.list())
        await syncOne(pack).catch((e: unknown) =>
          console.error("%s", `[skill-sync] pack ${pack.id} failed:`, errMessage(e)),
        );
    });
  }

  const tick = async (): Promise<void> => {
    await leaderLease.hold(TICK_LEASE_KEY, syncAll);
  };

  const sweeper = createSweeper(
    () => tick().catch(reportFailureAs("skill-sync: tick", undefined)),
    DEFAULT_INTERVAL_MS,
    { label: "skill-sync" },
  );
  return { tick, start: sweeper.start, stop: sweeper.stop };
}
