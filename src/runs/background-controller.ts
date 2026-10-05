import type { BackgroundOwnershipStore } from "./background-ownership.ts";

export interface BackgroundControllerDeps {
  store: Pick<BackgroundOwnershipStore, "get">;
  deploymentId: string;
  start(signal: AbortSignal): Promise<void>;
  fence(): void;
  relinquish(): Promise<void>;
  drained(): Promise<void>;
  onError(error: unknown): void;
  validityMs?: number;
  startupTimeoutMs?: number;
  pollMs?: number;
}

export function createBackgroundController(deps: BackgroundControllerDeps) {
  let running = false;
  let activation: AbortController | null = null;
  let validUntil = 0;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let poller: ReturnType<typeof setInterval> | null = null;
  let pending: Promise<void> | null = null;
  let starting = false;
  let refreshing: Promise<void> | null = null;
  let draining: Promise<void> = Promise.resolve();
  const validityMs = deps.validityMs ?? 10_000;
  const fence = (): void => {
    validUntil = 0;
    activation?.abort();
    deps.fence();
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  };
  const release = async (): Promise<void> => {
    fence();
    if (!activation) return;
    activation = null;
    await deps.relinquish();
    draining = deps.drained();
    void draining.catch(deps.onError);
  };
  const renew = (): void => {
    validUntil = Date.now() + validityMs;
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(fence, validityMs);
    watchdog.unref?.();
  };
  const owned = async (): Promise<boolean> => (await deps.store.get()).ownerDeploymentId === deps.deploymentId;
  const refreshStartup = (): Promise<void> => {
    if (!starting || !running || !activation || activation.signal.aborted) return Promise.resolve();
    if (refreshing) return refreshing;
    const current = activation;
    refreshing = (async () => {
      try {
        const stillOwned = await owned();
        if (!starting || !running || activation !== current || current.signal.aborted) return;
        if (stillOwned) renew();
        else fence();
      } catch (error) {
        if (starting && activation === current) {
          fence();
          deps.onError(error);
        }
      }
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };
  const reconcile = (): Promise<void> => {
    if (pending) {
      if (starting) void refreshStartup();
      return pending;
    }
    pending = (async () => {
      try {
        const owner = await owned();
        const desired = running && owner;
        if (activation && (!desired || activation.signal.aborted)) await release();
        if (!desired) return;
        if (activation) {
          renew();
          return;
        }
        const current = new AbortController();
        activation = current;
        renew();
        starting = true;
        const startupDeadline = setTimeout(() => {
          fence();
          deps.onError(new Error("Background startup timed out; waiting for activation cleanup before retrying"));
        }, deps.startupTimeoutMs ?? 120_000);
        startupDeadline.unref?.();
        try {
          await deps.start(current.signal);
        } finally {
          clearTimeout(startupDeadline);
          starting = false;
        }
        if (current.signal.aborted || !running) await release();
      } catch (error) {
        fence();
        try {
          await release();
        } catch (releaseError) {
          deps.onError(releaseError);
        }
        deps.onError(error);
      }
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
  return {
    canClaim: () => running && activation !== null && !activation.signal.aborted && Date.now() < validUntil,
    reconcile,
    start() {
      if (running) return;
      running = true;
      poller = setInterval(() => void reconcile(), deps.pollMs ?? 1_000);
      poller.unref?.();
      void reconcile();
    },
    async stop() {
      running = false;
      fence();
      if (poller) clearInterval(poller);
      poller = null;
      await pending;
      await release();
    },
    drained: () => draining,
  };
}
