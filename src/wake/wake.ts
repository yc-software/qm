import type { RunSignalKind } from "../runs/run-signal-store.ts";

export function isHalt(text: string): boolean {
  return /^stop[.!]?$/i.test(text.trim());
}

export interface Wake {
  situation: "addressed" | "ambientUpdate";
  text?: string;
  halt?: boolean;
  hasFiles?: boolean;
}

export type WakeRoute = { kind: "engage" } | { kind: "steer"; signal: RunSignalKind; text?: string };

export function routeWake(wake: Wake, liveRunGated = false): WakeRoute {
  if (wake.halt) return { kind: "steer", signal: "abort" };
  if (liveRunGated && wake.situation === "addressed") return { kind: "engage" };
  const text = wake.text?.trim();
  if (!text && !wake.hasFiles) throw new Error("routeWake: mid-turn message has no text and no files");
  return { kind: "steer", signal: "steer", ...(text ? { text } : {}) };
}
