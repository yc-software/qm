import type { BackgroundWakeTrigger } from "../types.ts";

const WAKE_TRIGGERS = new Set(["cron", "webhook", "monitor"]);

export interface ParsedWakeFireKey {
  trigger: BackgroundWakeTrigger;
  sourceId: string;
  fireSlot: string | null;
  fireKey: string;
}

export function wakeTriggerLabel(trigger: string | undefined | null): string {
  switch ((trigger ?? "").toLowerCase()) {
    case "cron":
      return "Cron";
    case "monitor":
      return "Monitor wake";
    case "webhook":
      return "Webhook wake";
    default:
      return "Background wake";
  }
}

export function parseWakeFireKey(fireKey: string | undefined | null): ParsedWakeFireKey | null {
  const match = /^([a-z][a-z0-9_-]*):([^:]+)(?::(.+))?$/.exec(fireKey ?? "");
  if (!match || !WAKE_TRIGGERS.has(match[1]!)) return null;
  return {
    trigger: match[1] as BackgroundWakeTrigger,
    sourceId: match[2]!,
    fireSlot: match[3] ?? null,
    fireKey: fireKey!,
  };
}
