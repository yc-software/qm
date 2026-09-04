import { SECURITY_QUARANTINE_REFUSAL_TEXT } from "../../plugins/chassis/src/security-quarantine.ts";

export function isBoundaryRefusal(reason: string | undefined): boolean {
  return (reason ?? "").startsWith("internal-only");
}

export function refusalDelivery(
  result: { refusalKind?: "security_quarantine" },
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
  result: { reason?: string; adminUrl?: string; refusalKind?: "security_quarantine" },
  kind: "dm" | "channel",
): string {
  if (result.refusalKind === "security_quarantine") {
    return SECURITY_QUARANTINE_REFUSAL_TEXT;
  }
  const reason = result.reason ?? "refused";
  if (isBoundaryRefusal(reason)) {
    return kind === "dm"
      ? `I can't respond just now — ${reason}.`
      : `I can't respond here — ${reason}. Try a DM or a fully-internal channel.`;
  }
  const detail = result.adminUrl ? ` Full error: ${result.adminUrl}` : "";
  return kind === "dm"
    ? `I hit an error and couldn't finish — ${reason}.${detail}`
    : `I hit an error and couldn't finish — ${reason}.${detail} Try again, or DM me.`;
}
