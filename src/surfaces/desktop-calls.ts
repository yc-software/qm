import { personKey } from "../directory/person.ts";
import type { RunSignalStore } from "../runs/run-signal-store.ts";
import type { SessionStateBus } from "../runs/session-state-bus.ts";
import type { ClientToolResult } from "../types.ts";
import { relayToClient, signalClient, type ClientAddress } from "./client-relay.ts";
import { uiStateId, type UiStateStore } from "./ui-state.ts";

const RESULT_MARGIN_MS = 10_000;

export const NO_DESKTOP_TEXT =
  "No QM desktop app answered, so nothing ran on the person's Mac. Ask them to open the QM desktop app on their Mac, then try again.";

export const DESKTOP_PERSON_ONLY_TEXT =
  "The desktop tool runs only in a turn started by a message the person addressed to you themselves, or by work that message started. This turn was started some other way, so nothing ran on their Mac. If they want it done, ask them to send the request as a new message.";
export const DESKTOP_UNAVAILABLE_TEXT =
  "This server can't relay desktop calls for this turn, so nothing ran on the person's Mac.";

export type DesktopCall = (
  callId: string,
  args: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<ClientToolResult | "timeout" | "cancelled">;

interface PendingCall {
  runId: string;
  args: unknown;
  deadline: number;
  clientId?: string;
  claimedBy?: string;
}

type RelayDeps = { bus: SessionStateBus; uiState: UiStateStore; signals: RunSignalStore };

const idOf = (principalId: string, callId: string) => uiStateId(personKey(principalId), `desktop:${callId}`);
const pendingOf = (row: { value: unknown } | null): PendingCall | null => (row?.value as PendingCall) ?? null;

export function desktopCallFor(
  deps: Partial<RelayDeps>,
  turn: ClientAddress & { runId?: string; clientId?: string },
): DesktopCall | undefined {
  const { bus, uiState, signals } = deps;
  const { runId, clientId, ...to } = turn;
  if (!bus || !uiState || !signals || !runId) return undefined;
  return async (callId, args, timeoutMs, signal) => {
    const pending: PendingCall = {
      runId,
      args,
      deadline: Date.now() + timeoutMs - RESULT_MARGIN_MS,
      ...(clientId ? { clientId } : {}),
    };
    const { outcome, last } = await relayToClient(
      { bus, uiState, signals },
      {
        to,
        pendingId: idOf(to.actorId, callId),
        pending: { ...pending },
        ui: { kind: "desktop", callId },
        timeoutMs,
        ...(signal ? { signal } : {}),
      },
    );
    const claimed = last === undefined ? undefined : Boolean(last?.claimedBy);
    if (outcome === "cancelled" && claimed !== false) signalClient(bus, to, { kind: "desktop", callId, stop: true });
    if (outcome === "timeout" && claimed === false) return { content: NO_DESKTOP_TEXT, isError: true };
    return outcome;
  };
}

export async function claimDesktopCall(uiState: UiStateStore, principalId: string, callId: string, clientId: string) {
  let won = false;
  const row = await uiState.update(idOf(principalId, callId), (current) => {
    won = false;
    const call = pendingOf(current);
    if (!call || call.claimedBy || (call.clientId && call.clientId !== clientId)) return current;
    won = true;
    return { ...current, value: { ...call, claimedBy: clientId } };
  });
  const call = pendingOf(row);
  return won && call?.claimedBy === clientId ? { runId: call.runId, args: call.args, deadline: call.deadline } : null;
}

export async function answerDesktopCall(
  deps: { uiState: UiStateStore; signals: RunSignalStore },
  principalId: string,
  callId: string,
  clientId: string,
  result: ClientToolResult,
): Promise<boolean> {
  const call = pendingOf(await deps.uiState.get(idOf(principalId, callId)));
  if (call?.claimedBy !== clientId) return false;
  return deps.signals.send(call.runId, {
    kind: "client_result",
    callId,
    result,
    dedupeKey: `client:${call.runId}:${callId}`,
  });
}
