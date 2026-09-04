import type { RunSignalKind } from "../runs/run-signal-store.ts";

export function isHalt(text: string): boolean {
  return /^stop[.!]?$/i.test(text.trim());
}

type WakeSituation = "addressed" | "engagedUpdate" | "ambientUpdate" | "scheduled";

export interface Wake {
  situation: WakeSituation;
  ts: string;
  text?: string;
  isSelf?: boolean;
  halt?: boolean;
  /** Names of files attached to the message — a file with no caption is still a message. */
  fileNames?: string[];
}

export type WakeRoute =
  { kind: "engage" } | { kind: "steer"; signal: RunSignalKind; text?: string } | { kind: "drop"; reason: string };

export function routeWake(wake: Wake, runIsLive: boolean, liveRunGated = false): WakeRoute {
  if (wake.isSelf) return { kind: "drop", reason: "self" };
  if (!runIsLive) {
    if (wake.halt) return { kind: "drop", reason: "halt-nothing-running" };
    return { kind: "engage" };
  }
  if (wake.halt) return { kind: "steer", signal: "abort" };
  if (liveRunGated && wake.situation === "addressed") return { kind: "engage" };
  const text = wake.text?.trim();
  const files = wake.fileNames?.length ? `[files attached mid-run: ${wake.fileNames.join(", ")}]` : "";
  if (!text && !files) return { kind: "drop", reason: "empty-mid-turn" };
  return { kind: "steer", signal: "steer", text: [text, files].filter(Boolean).join("\n") };
}
