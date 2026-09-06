import type { TurnResult } from "../types.ts";
import { standaloneFailureText, userFacingFailureClause } from "../core/failure-copy.ts";

export function isBoundaryRefusal(reason: string | undefined): boolean {
  return (reason ?? "").startsWith("internal-only");
}

export function refusalDelivery(
  result: { refusalKind?: TurnResult["refusalKind"] },
  unprompted: boolean,
): "thread" | "requester" | "silent" {
  if (unprompted) return "silent";
  return result.refusalKind === "security_quarantine" ? "thread" : "requester";
}

export async function postThenAckRunDelivery(opts: {
  post: () => Promise<unknown>;
  ack: () => void;
  release: () => void;
}): Promise<void> {
  try {
    await opts.post();
  } catch (err) {
    opts.release();
    throw err;
  }
  opts.ack();
}

export function refusalNote(
  result: { status?: string; reason?: string; adminUrl?: string; refusalKind?: TurnResult["refusalKind"] },
  kind: "dm" | "channel",
): string {
  const standalone = standaloneFailureText(result);
  if (standalone) return standalone;
  const reason = result.reason ?? "refused";
  if (isBoundaryRefusal(reason)) {
    return kind === "dm"
      ? `I can't respond just now — ${reason}.`
      : `I can't respond here — ${reason}. Try a DM or a fully-internal channel.`;
  }
  const clause = userFacingFailureClause(result);
  const detail = result.adminUrl ? ` Full error: ${result.adminUrl}` : "";
  return kind === "dm"
    ? `I hit an error and couldn't finish — ${clause}.${detail}`
    : `I hit an error and couldn't finish — ${clause}.${detail} Try again, or DM me.`;
}
