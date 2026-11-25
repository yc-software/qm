import { errMessage } from "../../chassis/src/errors.ts";
import { reportHandledError } from "./browser-errors.ts";

type Result = {
  content: string;
  isError?: boolean;
  images?: Array<{ data: string; mimeType: "image/png" | "image/jpeg" }>;
};
export type Desk = {
  call(args: unknown, clientId: string, deadline: number): Promise<Result>;
  stop?(clientId: string): Promise<unknown>;
};
type Claim = { runId: string; args: unknown; deadline: number };
type Post = (path: string, body: unknown) => Promise<unknown>;

const windowId = crypto.randomUUID();
const running = new Map<string, string>();
const claiming = new Set<string>();
const stopped = new Set<string>();
const unlessGone = (error: unknown) => {
  if ((error as { status?: number }).status === 404) return null;
  throw error;
};

function desktop(): Desk | undefined {
  return (globalThis as { window?: { qmDesktop?: { computer?: Desk; platform?: string } } }).window?.qmDesktop
    ?.platform === "darwin"
    ? (globalThis as { window?: { qmDesktop?: { computer?: Desk } } }).window?.qmDesktop?.computer
    : undefined;
}

export function inDesktopApp(): boolean {
  return Boolean((globalThis as { window?: { qmDesktop?: unknown } }).window?.qmDesktop);
}

export function webClientSurface(): "desktop" | "browser" {
  return inDesktopApp() ? "desktop" : "browser";
}

export function desktopTurnId(): string | undefined {
  return desktop() ? windowId : undefined;
}

export async function answerDesktopCall(callId: string, post: Post, desk = desktop()): Promise<void> {
  if (!desk || claiming.has(callId) || running.has(callId)) return;
  const path = `/api/desktop/calls/${encodeURIComponent(callId)}`;
  claiming.add(callId);
  const claim = (await post(`${path}/claim`, { desktopClientId: windowId })
    .catch(unlessGone)
    .finally(() => claiming.delete(callId))) as Claim | null;
  const stop = stopped.delete(callId);
  if (!claim) return;
  if (stop) {
    await post(`${path}/result`, {
      desktopClientId: windowId,
      result: { content: "The turn was stopped before the call started, so nothing ran on the Mac.", isError: true },
    }).catch(unlessGone);
    return;
  }
  running.set(callId, claim.runId);
  const result = await desk
    .call(claim.args, claim.runId, claim.deadline)
    .catch((error: unknown): Result => ({ content: errMessage(error), isError: true }))
    .finally(() => running.delete(callId));
  await post(`${path}/result`, { desktopClientId: windowId, result }).catch(async (error: unknown) => {
    reportHandledError("desktop-computer", error);
    await post(`${path}/result`, {
      desktopClientId: windowId,
      result: {
        content: `The desktop app ran the call but couldn't send its result: ${errMessage(error)}`,
        isError: true,
      },
    });
  });
}

export function stopDesktopCall(callId: string, desk = desktop()): void {
  const runId = running.get(callId);
  if (runId) void desk?.stop?.(runId);
  else if (claiming.has(callId)) stopped.add(callId);
}

export function handleDesktopSignal(ui: { callId?: string; stop?: boolean }, post: Post): void {
  if (!ui.callId) return;
  if (ui.stop) return stopDesktopCall(ui.callId);
  void answerDesktopCall(ui.callId, post).catch((error: unknown) => reportHandledError("desktop-computer", error));
}
