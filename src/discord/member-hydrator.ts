import { jitteredBackoffMs } from "../util/async.ts";
import { DISCORD_RETRY_BASE_MS, DISCORD_RETRY_MAX_MS } from "./config.ts";

export interface MemberHydrator {
  hydrate(): void;
  invalidate(): void;
  ready(guildId: string): boolean;
  allReady(): boolean;
  stop(): void;
}

function rateLimitRetryAfterMs(err: unknown): number {
  const seconds = (err as { data?: { retry_after?: unknown } } | null)?.data?.retry_after;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 0;
}

export function createMemberHydrator(opts: {
  guildIds: ReadonlySet<string>;
  fetchAll(guildId: string): Promise<void>;
  onError?: (guildId: string, err: unknown) => void;
  onAllReady?: () => void;
}): MemberHydrator {
  const ready = new Set<string>();
  const retries = new Set<ReturnType<typeof setTimeout>>();
  let generation = 0;
  let stopped = false;
  const allReady = () => [...opts.guildIds].every((g) => ready.has(g));

  function fetchGuild(guildId: string, attempt: number, gen: number): void {
    void opts.fetchAll(guildId).then(
      () => {
        if (gen !== generation || stopped) return;
        ready.add(guildId);
        if (allReady()) opts.onAllReady?.();
      },
      (err: unknown) => {
        opts.onError?.(guildId, err);
        if (gen !== generation || stopped) return;
        const retry = setTimeout(
          () => {
            retries.delete(retry);
            fetchGuild(guildId, attempt + 1, gen);
          },
          Math.min(
            DISCORD_RETRY_MAX_MS,
            Math.max(
              jitteredBackoffMs(attempt, { baseDelayMs: DISCORD_RETRY_BASE_MS, maxDelayMs: DISCORD_RETRY_MAX_MS }),
              rateLimitRetryAfterMs(err),
            ),
          ),
        );
        retries.add(retry);
      },
    );
  }

  function invalidate(): void {
    generation += 1;
    for (const retry of retries) clearTimeout(retry);
    retries.clear();
    ready.clear();
  }

  return {
    hydrate() {
      if (stopped) return;
      invalidate();
      for (const guildId of opts.guildIds) fetchGuild(guildId, 1, generation);
    },
    invalidate,
    ready: (guildId) => ready.has(guildId),
    allReady,
    stop() {
      stopped = true;
      invalidate();
    },
  };
}
