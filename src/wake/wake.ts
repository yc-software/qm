import type { RunSignalKind } from "../runs/run-signal-store.ts";

export function isHalt(text: string): boolean {
  return /^stop[.!]?$/i.test(text.trim());
}

export interface Wake {
  situation: "addressed" | "ambientUpdate";
  text?: string;
  halt?: boolean;
  /** Names of files attached to the message — a file with no caption is still a message. */
  fileNames?: string[];
}

export type WakeRoute = { kind: "engage" } | { kind: "steer"; signal: RunSignalKind; text?: string };

export function routeWake(wake: Wake, liveRunGated = false): WakeRoute {
  if (wake.halt) return { kind: "steer", signal: "abort" };
  if (liveRunGated && wake.situation === "addressed") return { kind: "engage" };
  const text = wake.text?.trim();
  const files = wake.fileNames?.length ? `[files attached mid-run: ${wake.fileNames.join(", ")}]` : "";
  if (!text && !files) throw new Error("routeWake: mid-turn message has no text and no files");
  return { kind: "steer", signal: "steer", text: [text, files].filter(Boolean).join("\n") };
}
