export class SlackPluginStartCleanupError extends AggregateError {
  readonly cleanup: () => Promise<void>;

  constructor(startError: unknown, cleanupError: unknown, cleanup: () => Promise<void>) {
    super([startError, cleanupError], "Slack startup failed and socket cleanup remains incomplete");
    this.cleanup = cleanup;
  }
}

export interface ReloadableSlackConfig<Config> {
  version: string;
  config: Config;
}

export function createSlackRuntimeReconciler<Config>(opts: {
  load: () => Promise<ReloadableSlackConfig<Config> | null>;
  startPlugin: (config: Config) => Promise<{ stop(): Promise<void> }>;
  intervalMs?: number;
  startPaused?: boolean;
  onError?: (error: unknown) => void;
}) {
  let active: { plugin: { stop(): Promise<void> }; version: string; config: Config } | null = null;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let stopped = opts.startPaused ?? false;
  let pendingCleanup: (() => Promise<void>) | null = null;

  const reconcile = async (): Promise<void> => {
    if (pendingCleanup) {
      await pendingCleanup();
      pendingCleanup = null;
    }
    const desired = await opts.load();
    if (stopped) return;
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
    if (stopped) return;
    try {
      const plugin = await opts.startPlugin(desired.config);
      active = { plugin, version: desired.version, config: desired.config };
    } catch (error) {
      if (error instanceof SlackPluginStartCleanupError) {
        pendingCleanup = error.cleanup;
        throw error;
      }
      if (previous && !stopped) {
        try {
          const plugin = await opts.startPlugin(previous.config);
          active = { plugin, version: previous.version, config: previous.config };
        } catch (rollbackError) {
          if (rollbackError instanceof SlackPluginStartCleanupError) pendingCleanup = rollbackError.cleanup;
          throw new AggregateError([error, rollbackError], "Slack reload and rollback both failed", {
            cause: rollbackError,
          });
        }
      }
      throw error;
    }
  };

  const run = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = reconcile().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  const tick = (): void => {
    void run().catch((error) => opts.onError?.(error));
  };

  return {
    start() {
      if (timer || stopping || (stopped && (active || pendingCleanup))) return;
      stopped = false;
      tick();
      timer = setInterval(tick, opts.intervalMs ?? 5_000);
      timer.unref();
    },
    reconcile: run,
    stop(): Promise<void> {
      if (stopping) return stopping;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      stopping = (async () => {
        await inFlight?.catch(() => {});
        if (pendingCleanup) {
          await pendingCleanup();
          pendingCleanup = null;
        }
        if (active) {
          await active.plugin.stop();
          active = null;
        }
      })().finally(() => {
        stopping = null;
      });
      return stopping;
    },
  };
}
