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
  if (!desk) return;
  const path = `/api/desktop/calls/${encodeURIComponent(callId)}`;
  const claim = (await post(`${path}/claim`, { desktopClientId: windowId }).catch(unlessGone)) as Claim | null;
  if (!claim) return;
  running.set(callId, claim.runId);
  const result = await desk
    .call(claim.args, claim.runId, claim.deadline)
    .catch((error: unknown): Result => ({ content: errMessage(error), isError: true }))
    .finally(() => running.delete(callId));
  await post(`${path}/result`, { desktopClientId: windowId, result }).catch(unlessGone);
}

export function stopDesktopCall(callId: string, desk = desktop()): void {
  const runId = running.get(callId);
  if (runId) void desk?.stop?.(runId);
}

export function handleDesktopSignal(ui: { callId?: string; stop?: boolean }, post: Post): void {
  if (!ui.callId) return;
  if (ui.stop) return stopDesktopCall(ui.callId);
  void answerDesktopCall(ui.callId, post).catch((error: unknown) => reportHandledError("desktop-computer", error));
}
