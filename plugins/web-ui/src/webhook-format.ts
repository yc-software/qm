import { relTime } from "./ui.ts";

export function webhookRunSummary(w: {
  lastReceivedAt?: number;
  lastFiredAt?: number;
  lastError?: string;
  lastRun?: { status?: string; firedAt: number; endedAt?: number };
}): string {
  if (w.lastRun && w.lastRun.firedAt >= (w.lastReceivedAt ?? 0)) {
    const status = w.lastRun.status ?? "received";
    return `${status} ${relTime(w.lastRun.endedAt ?? w.lastRun.firedAt)}`;
  }
  if (w.lastReceivedAt && w.lastReceivedAt >= (w.lastFiredAt ?? 0)) return `received ${relTime(w.lastReceivedAt)}`;
  if (w.lastError) return "error";
  return w.lastFiredAt ? relTime(w.lastFiredAt) : "never fired";
}
