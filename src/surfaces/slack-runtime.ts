import type { SubscribeOptions } from "../util/event-bus.ts";

export interface ReloadableSlackConfig<Config> {
  version: string;
  config: Config;
}

const REPAIR_MS = 300_000;
const RETRY_MS = 5_000;

export function createSlackRuntimeReconciler<Config>(opts: {
  load: () => Promise<ReloadableSlackConfig<Config> | null>;
  startPlugin: (config: Config) => Promise<{ stop(): Promise<void> }>;
  changes?: { subscribe(cb: () => void, opts?: SubscribeOptions): () => void };
  repairMs?: number;
  retryMs?: number;
  onError?: (error: unknown) => void;
}) {
  let active: { plugin: { stop(): Promise<void> }; version: string; config: Config } | null = null;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let pending: Promise<void> | null = null;
  let unsubscribe: (() => void) | null = null;
  let stopped = false;

  const reconcile = async (): Promise<void> => {
    const desired = await opts.load();
    if (!desired) {
      if (active) {
        await active.plugin.stop();
        active = null;
      }
      return;
    }
    if (desired.version === active?.version) return;
    const previous = active;
    if (previous) {
      await previous.plugin.stop();
      active = null;
    }
    try {
      const plugin = await opts.startPlugin(desired.config);
      active = { plugin, version: desired.version, config: desired.config };
    } catch (error) {
      if (previous) {
        try {
          const plugin = await opts.startPlugin(previous.config);
          active = { plugin, version: previous.version, config: previous.config };
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Slack reload and rollback both failed", {
            cause: rollbackError,
          });
        }
      }
      throw error;
    }
  };

  const run = (): Promise<void> => {
    if (!inFlight) {
      inFlight = reconcile().finally(() => {
        inFlight = null;
      });
      return inFlight;
    }
    pending ??= inFlight
      .catch(() => {})
      .then(() => {
        pending = null;
        return stopped ? undefined : run();
      });
    return pending;
  };

  const tick = async (): Promise<void> => {
    let failed = false;
    try {
      await run();
    } catch (error) {
      failed = true;
      opts.onError?.(error);
    }
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), failed ? (opts.retryMs ?? RETRY_MS) : (opts.repairMs ?? REPAIR_MS));
    timer.unref?.();
  };

  return {
    start() {
      unsubscribe = opts.changes?.subscribe(() => void tick(), { onResync: () => void tick() }) ?? null;
      void tick();
    },
    reconcile: run,
    async stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        await (pending ?? inFlight);
      } finally {
        if (active) {
          await active.plugin.stop();
          active = null;
        }
      }
    },
  };
}
