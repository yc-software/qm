import { readFileSync } from "node:fs";

export type Fire = { sessionId: string; createdAt: number; cronId: string; cronTitle: string; reply: string | null; status: "replied" | "silent"; destinationType: string };

export const ALERT_TITLE = /alert|fail|crash|502|health|error|broken|incident|outage|rca/i;

export function loadReplied(path: string): Fire[] {
  const rows = JSON.parse(readFileSync(path, "utf8")) as Fire[];
  return rows.filter((r) => r.status === "replied" && r.reply).sort((a, b) => a.createdAt - b.createdAt);
}

export function isUrgentHint(f: Fire): boolean {
  return /^\s*\[urgent\]/i.test(f.reply ?? "") || ALERT_TITLE.test(f.cronTitle);
}

const LA = "America/Los_Angeles";

function laParts(ms: number) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: LA, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return { y: g("year"), mo: g("month"), d: g("day"), h: g("hour"), mi: g("minute") };
}

export function laClock(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { timeZone: LA, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function laWallToEpoch(y: number, mo: number, d: number, h: number): number {
  let guess = Date.UTC(y, mo - 1, d, h + 8);
  for (let i = 0; i < 3; i++) {
    const p = laParts(guess);
    const diff = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Date.UTC(y, mo - 1, d, h, 0);
    guess -= diff;
  }
  return guess;
}

export function flushTimes(from: number, to: number): number[] {
  const out: number[] = [];
  const start = laParts(from);
  for (let k = -1; k < 5; k++) {
    for (const h of [9, 17]) {
      const t = laWallToEpoch(start.y, start.mo, start.d + k, h);
      if (t > from && t <= to) out.push(t);
    }
  }
  return out.sort((a, b) => a - b);
}
