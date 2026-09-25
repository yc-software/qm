import type { BackgroundMember, BackgroundOwnershipStore } from "./background-ownership.ts";
import { BackgroundOwnershipConflict } from "./background-ownership.ts";

export interface BackgroundControllerDeps {
  store: BackgroundOwnershipStore;
  identity: Pick<BackgroundMember, "instanceId" | "deploymentId" | "taskArn">;
  legacyEnabled: boolean;
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
  let registered = false;
  let admission: number | null = null;
  let admissionEpoch = 0;
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
    if (admission === null) return;
    await deps.relinquish();
    const generation = admission;
    const epoch = admissionEpoch;
    await deps.store.acknowledge(deps.identity.instanceId, generation, "relinquished");
    admission = null;
    activation = null;
    draining = deps.drained().then(async () => {
      if (admission === null && epoch === admissionEpoch)
        await deps.store.acknowledge(deps.identity.instanceId, generation, "drained");
    });
    void draining.catch(deps.onError);
  };
  const renew = (): void => {
    validUntil = Date.now() + validityMs;
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(fence, validityMs);
    watchdog.unref?.();
  };
  const refreshStartup = (): Promise<void> => {
    if (!starting || !running || !activation || activation.signal.aborted) return Promise.resolve();
    if (refreshing) return refreshing;
    const currentActivation = activation;
    const generation = admission;
    refreshing = (async () => {
      try {
        const state = await deps.store.get();
        if (!starting || !running || activation !== currentActivation || currentActivation?.signal.aborted) return;
        const member = state.members.find((entry) => entry.instanceId === deps.identity.instanceId);
        if (
          state.generation !== generation ||
          !member ||
          member.retired ||
          member.state !== "admitted" ||
          member.generation !== generation ||
          !(state.enabled ? state.desiredDeploymentId === deps.identity.deploymentId : deps.legacyEnabled)
        ) {
          fence();
          return;
        }
        renew();
      } catch (error) {
        if (starting && activation === currentActivation) {
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
        if (!registered) {
          await deps.store.register(deps.identity);
          registered = true;
        }
        const state = await deps.store.get();
        const member = state.members.find((entry) => entry.instanceId === deps.identity.instanceId);
        const desired =
          running &&
          member !== undefined &&
          !member.retired &&
          (state.enabled ? state.desiredDeploymentId === deps.identity.deploymentId : deps.legacyEnabled);
        if (admission !== null && (!desired || state.generation !== admission || activation?.signal.aborted))
          await release();
        if (!desired) return;
        if (admission === null) {
          await deps.store.admit(deps.identity.instanceId, state.generation, deps.legacyEnabled);
          admission = state.generation;
          admissionEpoch++;
          activation = new AbortController();
          renew();
          if (!running) {
            await release();
            return;
          }
          starting = true;
          const startupDeadline = setTimeout(() => {
            fence();
            deps.onError(new Error("Background startup timed out; waiting for activation cleanup before retrying"));
          }, deps.startupTimeoutMs ?? 120_000);
          startupDeadline.unref?.();
          try {
            await deps.start(activation.signal);
          } finally {
            clearTimeout(startupDeadline);
            starting = false;
          }
          if (activation.signal.aborted || !running) await release();
          else await deps.store.markReady(deps.identity.instanceId, state.generation);
        } else {
          renew();
        }
      } catch (error) {
        fence();
        try {
          await release();
        } catch (releaseError) {
          deps.onError(releaseError);
        }
        if (!(error instanceof BackgroundOwnershipConflict)) deps.onError(error);
      }
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
  return {
    canClaim: () => running && admission !== null && !activation?.signal.aborted && Date.now() < validUntil,
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
