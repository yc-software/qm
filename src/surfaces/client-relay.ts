import { waitForClientResult, type RunSignalStore } from "../runs/run-signal-store.ts";
import type { SessionStateBus, UiSignal } from "../runs/session-state-bus.ts";
import { swallowAs } from "../util/errors.ts";
import type { UiStateStore } from "./ui-state.ts";

export interface ClientAddress {
  actorId: string;
  sessionId: string;
  threadRef: string;
}

export function signalClient(bus: SessionStateBus | undefined, to: ClientAddress, ui: UiSignal): void {
  bus?.emit({
    threadRef: to.threadRef,
    sessionId: to.sessionId,
    participants: [to.actorId],
    state: "ui",
    at: Date.now(),
    ui,
  });
}

export async function relayToClient(
  deps: { bus?: SessionStateBus; uiState: UiStateStore; signals: RunSignalStore },
  req: {
    to: ClientAddress;
    pendingId: string;
    pending: { runId: string } & Record<string, unknown>;
    ui: UiSignal & { callId: string };
    timeoutMs: number;
    signal?: AbortSignal;
  },
) {
  await deps.uiState.put(req.pendingId, { value: req.pending, updatedAt: Date.now() });
  signalClient(deps.bus, req.to, req.ui);
  const taken = () => deps.uiState.take(req.pendingId).catch(swallowAs("client relay pending cleanup", undefined));
  const outcome = await waitForClientResult(deps.signals, req.pending.runId, req.ui.callId, {
    timeoutMs: req.timeoutMs,
    ...(req.signal ? { signal: req.signal } : {}),
  }).catch(async (error: unknown) => {
    await taken();
    throw error;
  });
  const last = await taken();
  return {
    outcome,
    last: (last === undefined ? undefined : (last?.value ?? null)) as Record<string, unknown> | null | undefined,
  };
}
