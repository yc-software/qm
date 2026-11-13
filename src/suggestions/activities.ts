import type { SuggestedActivity } from "../../plugins/chassis/src/suggested-activities.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { CronStore } from "../cron/cron-store.ts";
import type { Scheduler } from "../cron/scheduler.ts";
import { claimManagedCron, nightlyAt, type ManagedCronClaim } from "../cron/managed.ts";
import { scopeId } from "../types.ts";
import type { Cron } from "../triggers/types.ts";
import type { Loop } from "../loops/types.ts";
import { GENERATED_COUNT, VISIBLE_COUNT, type SuggestionItems } from "./loop-items.ts";
import { loopCronAction } from "../loops/loop-store.ts";

export interface SuggestedActivityProfile extends ManagedCronClaim {
  timezone: string;
  lastSeenAt: number;
  lastBootstrapAt?: number;
  seeds?: SuggestedActivity[];
}

export interface SuggestedActivityResult {
  activities: SuggestedActivity[];
  pending: boolean;
}

const STALE_AFTER_MS = 4 * 60 * 60_000;

export function createSuggestedActivityService(deps: {
  store: DurableMap<SuggestedActivityProfile>;
  suggestions: SuggestionItems;
  crons: CronStore;
  scheduler: Pick<Scheduler, "notifyChanged" | "runNow">;
  enabled: boolean;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const owned = (cron: Cron | null, principalId: string): cron is Cron =>
    !!cron && cron.owner === principalId && cron.ownerScopeId === scopeId("personal", principalId);

  const claim = (principalId: string, profile: SuggestedActivityProfile, loop: Loop) =>
    claimManagedCron(deps, principalId, profile, {
      owner: principalId,
      createdBy: principalId,
      ownerScopeId: scopeId("personal", principalId),
      title: "Refresh my suggested activities",
      schedule: { cron: nightlyAt(principalId, 2), timezone: profile.timezone },
      action: loopCronAction(loop.id),
      loopId: loop.id,
    });

  const release = async (principalId: string, profile: SuggestedActivityProfile, cronId: string) =>
    (await deps.store.update(principalId, (value) => {
      if (value.cronId !== cronId) return value;
      const { cronId: _cronId, arming: _arming, lastBootstrapAt: _lastBootstrapAt, ...rest } = value;
      return rest;
    })) ?? profile;

  const claimRefresh = async (
    principalId: string,
    profile: SuggestedActivityProfile,
    due: (last: number) => boolean,
  ): Promise<boolean> => {
    if (!due(profile.lastBootstrapAt ?? 0)) return false;
    let won = false;
    const timestamp = now();
    await deps.store.update(principalId, (value) => {
      won = due(value.lastBootstrapAt ?? 0);
      return won ? { ...value, lastBootstrapAt: timestamp } : value;
    });
    return won;
  };

  return {
    async get(
      principalId: string,
      seeds: SuggestedActivity[],
      {
        timezone = "UTC",
        poll = false,
        refresh = false,
      }: { timezone?: string; poll?: boolean; refresh?: boolean } = {},
    ): Promise<SuggestedActivityResult> {
      if (!deps.enabled) return { activities: seeds.slice(0, GENERATED_COUNT), pending: false };
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      let profile = await deps.store.putIfAbsent(principalId, { timezone, lastSeenAt: now() });
      const seen = poll ? {} : { lastSeenAt: now() };
      await deps.store.merge(principalId, { ...seen, seeds });
      profile = { ...profile, ...seen, seeds };
      let cron = !profile.cronId || profile.arming ? null : await deps.crons.get(profile.cronId);
      if (owned(cron, principalId) && !cron.loopId) {
        await deps.crons.delete(cron.id);
        profile = await release(principalId, profile, cron.id);
        cron = null;
      }
      let loop = cron?.loopId ? await deps.suggestions.getLoop(cron.loopId) : null;
      if (!profile.cronId || profile.arming) {
        loop = await deps.suggestions.ensureLoop(principalId);
        profile = await claim(principalId, profile, loop);
        cron = await deps.crons.get(profile.cronId!);
      }
      const usable = owned(cron, principalId) && !cron.archived;
      if (loop && usable) await deps.suggestions.bind(loop, cron!.id);
      const batch = loop ? await deps.suggestions.current(loop.id) : undefined;
      const fallback = seeds.filter((seed) => !batch?.dismissed.has(seed.id)).slice(0, GENERATED_COUNT);
      if (!batch || !usable || !cron) return { activities: fallback, pending: false };
      const { runs } = await deps.crons.listFires(cron.id, { limit: 10 });
      let pending = runs.some((run) => run.status === "running");
      if (!pending && cron.enabled) {
        const reserveExhausted = batch.depth === 0 || (batch.depth <= VISIBLE_COUNT && batch.depth < batch.batchSize);
        const claimed =
          ((refresh || !poll) &&
            reserveExhausted &&
            (await claimRefresh(principalId, profile, (last) => last < batch.batchAt))) ||
          (batch.batchAt <= now() - STALE_AFTER_MS &&
            (await claimRefresh(principalId, profile, (last) => last <= now() - STALE_AFTER_MS)));
        if (claimed) {
          const result = await deps.scheduler.runNow(cron.id);
          pending = result.started || result.reason === "already_running";
        }
      }
      return { activities: batch.depth ? batch.activities : fallback, pending };
    },

    async dismiss(principalId: string, id: string): Promise<boolean> {
      if (!deps.enabled) return false;
      const profile = await deps.store.get(principalId);
      const cron = profile?.cronId ? await deps.crons.get(profile.cronId) : null;
      if (!cron?.loopId) return false;
      const seed = profile?.seeds?.find((candidate) => candidate.id === id);
      return deps.suggestions.dismiss(cron.loopId, id, seed);
    },

    async skipFire(cron: Cron): Promise<string | undefined> {
      if (!cron.ownerScopeId.startsWith("personal:")) return undefined;
      const profile = await deps.store.get(cron.owner);
      if (profile?.cronId !== cron.id) return undefined;
      if (!deps.enabled) return "suggested activities are turned off";
      const { runs } = await deps.crons.listFires(cron.id, { limit: 1 });
      const last = runs.at(-1);
      return last && profile.lastSeenAt <= last.firedAt ? "no new sessions opened since the last refresh" : undefined;
    },
  };
}
