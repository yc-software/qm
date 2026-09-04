import type { ScopeId, SessionType } from "../types.ts";
import type { AttributedTurn, ParticipantWindow } from "../sessions/session-store.ts";
import { forEachAttributedTurn } from "./attribution.ts";

const DAY = 86_400_000;

export interface RetentionInput {
  sessions: { id: string; type: SessionType; scopeId: ScopeId; createdAt: number }[];
  participants: ParticipantWindow[];
  turns: AttributedTurn[];
  nowMs: number;
}

interface CohortRow {
  week: string;
  size: number;
  retained: number[];
}

export interface RetentionReport {
  generatedAt: number;
  active: { dau: number; wau: number; mau: number; stickiness: number };
  newVsReturning: { window: string; newUsers: number; returning: number };
  cohorts: CohortRow[];
  perUser: { sessions: { p50: number; p95: number }; turns: { p50: number; p95: number } };
  totals: { users: number; sessions: number };
  attribution: string;
  note: string;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function computeRetention(input: RetentionInput): RetentionReport {
  const { sessions, participants, turns, nowMs } = input;

  const activeDays = new Map<string, Set<number>>();
  const turnsByUser = new Map<string, number>();
  const sessionsByUser = new Map<string, Set<string>>();

  forEachAttributedTurn(
    { participants, turns, sessionIds: sessions.map((s) => s.id) },
    {
      onWindow(sessionId, w) {
        const set = sessionsByUser.get(w.principalId);
        if (set) set.add(sessionId);
        else sessionsByUser.set(w.principalId, new Set([sessionId]));
      },
      onTurn(w, turn) {
        const days = activeDays.get(w.principalId);
        if (days) days.add(turn.day);
        else activeDays.set(w.principalId, new Set([turn.day]));
        turnsByUser.set(w.principalId, (turnsByUser.get(w.principalId) ?? 0) + turn.turns);
      },
    },
  );

  const today = Math.floor(nowMs / DAY);
  const users = [...activeDays.keys()];
  const activeInLast = (principal: string, days: number) => {
    const set = activeDays.get(principal);
    if (!set) return false;
    for (const d of set) if (d > today - days && d <= today) return true;
    return false;
  };
  const dau = users.filter((u) => activeInLast(u, 1)).length;
  const wau = users.filter((u) => activeInLast(u, 7)).length;
  const mau = users.filter((u) => activeInLast(u, 30)).length;
  const stickiness = mau ? Math.round((dau / mau) * 100) : 0;

  const firstDay = new Map<string, number>();
  for (const [u, set] of activeDays) firstDay.set(u, Math.min(...set));
  const windowStart = today - 30;
  let newUsers = 0;
  let returning = 0;
  for (const u of users) {
    if (!activeInLast(u, 30)) continue;
    if ((firstDay.get(u) ?? 0) > windowStart) newUsers++;
    else returning++;
  }

  const weekOf = (d: number) => Math.floor(d / 7);
  const weeksActive = new Map<string, Set<number>>();
  const cohortMembers = new Map<number, string[]>();
  for (const [u, set] of activeDays) {
    const weeks = new Set<number>();
    for (const d of set) weeks.add(weekOf(d));
    weeksActive.set(u, weeks);
    const firstWeek = Math.min(...weeks);
    const arr = cohortMembers.get(firstWeek);
    if (arr) arr.push(u);
    else cohortMembers.set(firstWeek, [u]);
  }
  const cohorts: CohortRow[] = [...cohortMembers.keys()]
    .sort((a, b) => a - b)
    .slice(-8)
    .map((cw) => {
      const members = cohortMembers.get(cw)!;
      const retained = [0, 1, 2, 3, 4].map((off) => {
        const active = members.filter((u) => weeksActive.get(u)!.has(cw + off)).length;
        return members.length ? Math.round((active / members.length) * 100) : 0;
      });
      return { week: new Date(cw * 7 * DAY).toISOString().slice(0, 10), size: members.length, retained };
    });

  const sessionCounts = users.map((u) => sessionsByUser.get(u)?.size ?? 0).sort((a, b) => a - b);
  const turnCounts = users.map((u) => turnsByUser.get(u) ?? 0).sort((a, b) => a - b);

  return {
    generatedAt: nowMs,
    active: { dau, wau, mau, stickiness },
    newVsReturning: { window: "30d", newUsers, returning },
    cohorts,
    perUser: {
      sessions: { p50: percentile(sessionCounts, 50), p95: percentile(sessionCounts, 95) },
      turns: { p50: percentile(turnCounts, 50), p95: percentile(turnCounts, 95) },
    },
    totals: { users: users.length, sessions: sessions.length },
    attribution: "DM/personal exact; channel approximate (entries carry no author principal).",
    note: "Derived per-request over all sessions × entries; move to a materialized daily rollup if volume grows.",
  };
}
