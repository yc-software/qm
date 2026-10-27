import { piFailedAssistant, type AssistantTextSession } from "./turn-recovery.ts";
import { swallowAs } from "../util/errors.ts";

export type TurnWallClockOutcome = "ok" | "aborted" | "abandoned";

const TURN_ABORT_GRACE_MS = 30_000;

export const EMPTY_ENDING_MIN_BUDGET_MS = 30_000;
export const EMPTY_ENDING_NOTE =
  "[system] The turn ended with an empty message. If the work above is unfinished, continue it — without redoing steps that already succeeded; otherwise reply with your answer now.";

export function emptyEndingNote(opts: {
  wallClock: TurnWallClockOutcome;
  userAborted: boolean;
  cancelled: boolean;
  surfaceTools: boolean;
  pollFire: boolean;
  halted: boolean;
  modelCalls: number;
  session: AssistantTextSession;
  turnWallClockMs: number;
  elapsedMs: number;
}): string | null {
  if (opts.wallClock !== "ok" || opts.userAborted || opts.cancelled || opts.surfaceTools) return null;
  if (opts.halted) return null;
  if (opts.pollFire) return null;
  if (opts.modelCalls === 0) return null;
  if (piFailedAssistant(opts.session)) return null;
  if ((opts.session.getLastAssistantText() ?? "").trim()) return null;
  if (opts.turnWallClockMs > 0 && opts.turnWallClockMs - opts.elapsedMs < EMPTY_ENDING_MIN_BUDGET_MS) return null;
  return EMPTY_ENDING_NOTE;
}

export async function raceTurnWallClock(
  prompting: Promise<void>,
  opts: { capMs: number; graceMs?: number; abort: () => Promise<void>; extendMs?: () => number },
): Promise<TurnWallClockOutcome> {
  if (!Number.isFinite(opts.capMs) || opts.capMs <= 0) {
    await prompting;
    return "ok";
  }
  let capTimer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  try {
    const settled = prompting.then(() => "settled" as const);
    let waitMs = opts.capMs;
    for (;;) {
      const deadline = new Promise<"deadline">((resolve) => {
        capTimer = setTimeout(() => resolve("deadline"), waitMs);
      });
      if ((await Promise.race([settled, deadline])) === "settled") return "ok";
      clearTimeout(capTimer);
      const extension = opts.extendMs?.() ?? 0;
      if (!(Number.isFinite(extension) && extension > 0)) break;
      waitMs = extension;
    }
    void opts.abort().catch(swallowAs("pi: wall-clock abort", undefined));
    const grace = new Promise<"grace">((resolve) => {
      graceTimer = setTimeout(() => resolve("grace"), opts.graceMs ?? TURN_ABORT_GRACE_MS);
    });
    if ((await Promise.race([settled.catch(() => "settled" as const), grace])) === "settled") return "aborted";
    prompting.catch(swallowAs("pi: abandoned capped turn", undefined));
    return "abandoned";
  } finally {
    clearTimeout(capTimer);
    clearTimeout(graceTimer);
  }
}

export function wallClockTurnFailure(
  wallClock: TurnWallClockOutcome,
  userAborted: boolean,
  cancelAborted: boolean,
): boolean {
  if (wallClock === "ok" || userAborted) return false;
  return !cancelAborted || wallClock === "abandoned";
}
