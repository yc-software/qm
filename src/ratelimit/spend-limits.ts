import { parseScopeId, scopeId as toScopeId, type ScopeId } from "../types.ts";
import type { SpendRow } from "../sessions/session-store.ts";

export interface SpendLimit {
  dailyUsd?: number;
  monthlyUsd?: number;
}

export interface SpendLimitStatus {
  scopeId: ScopeId;
  limit: SpendLimit;
  orgDefault: boolean;
  todayUsd: number;
  monthUsd: number;
  over: "daily" | "monthly" | null;
}

interface SpendLimitDeps {
  orgId: () => string;
  getSpendLimit: (scope: ScopeId) => Promise<SpendLimit | null>;
  spendReport: (range: { from: number; to: number }) => Promise<{ rows: SpendRow[] }>;
  now?: () => number;
  cacheMs?: number;
}

interface Totals {
  at: number;
  monthStart: number;
  today: number;
  totals: Map<ScopeId, { today: number; month: number }>;
}

const DAY_MS = 86_400_000;
const CACHE_MS = 60_000;

export function parseSpendLimit(body: unknown): { value: SpendLimit | null } | { error: string } {
  const b = (body ?? {}) as { dailyUsd?: unknown; monthlyUsd?: unknown; inherit?: unknown };
  if (b.inherit === true) return { value: null };
  const limit: SpendLimit = {};
  for (const key of ["dailyUsd", "monthlyUsd"] as const) {
    const raw = b[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const n = typeof raw === "string" ? Number(raw.trim()) : raw;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0)
      return {
        error:
          "spend-limit takes { dailyUsd?, monthlyUsd? } as non-negative dollar amounts ({} means no limit here; { inherit: true } clears it)",
      };
    limit[key] = n;
  }
  return { value: limit };
}

export function createSpendLimits(deps: SpendLimitDeps) {
  const now = deps.now ?? Date.now;
  const cacheMs = deps.cacheMs ?? CACHE_MS;
  let cached: Totals | null = null;
  let inflight: Promise<Totals> | null = null;

  const totals = async (): Promise<Totals> => {
    const t = now();
    const d = new Date(t);
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const today = Math.floor(t / DAY_MS);
    if (cached && cached.monthStart === monthStart && cached.today === today && t - cached.at < cacheMs) return cached;
    inflight ??= (async () => {
      try {
        const { rows } = await deps.spendReport({ from: monthStart, to: (today + 1) * DAY_MS });
        const byScope = new Map<ScopeId, { today: number; month: number }>();
        for (const row of rows) {
          const acc = byScope.get(row.scopeId) ?? { today: 0, month: 0 };
          acc.month += row.costUsd;
          if (row.day === today) acc.today += row.costUsd;
          byScope.set(row.scopeId, acc);
        }
        const fresh: Totals = { at: t, monthStart, today, totals: byScope };
        cached = fresh;
        return fresh;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  const effectiveLimit = async (scopeId: ScopeId): Promise<{ limit: SpendLimit; orgDefault: boolean } | null> => {
    const own = await deps.getSpendLimit(scopeId);
    if (own) return { limit: own, orgDefault: false };
    if (parseScopeId(scopeId).kind !== "personal") return null;
    const fallback = await deps.getSpendLimit(toScopeId("org", deps.orgId()));
    return fallback ? { limit: fallback, orgDefault: true } : null;
  };

  return {
    async status(scopeId: ScopeId): Promise<SpendLimitStatus | null> {
      const applies = await effectiveLimit(scopeId);
      if (!applies) return null;
      const { limit } = applies;
      if (limit.dailyUsd === undefined && limit.monthlyUsd === undefined) return null;
      const spent = (await totals()).totals.get(scopeId) ?? { today: 0, month: 0 };
      let over: SpendLimitStatus["over"] = null;
      if (limit.dailyUsd !== undefined && spent.today >= limit.dailyUsd) over = "daily";
      else if (limit.monthlyUsd !== undefined && spent.month >= limit.monthlyUsd) over = "monthly";
      return { scopeId, limit, orgDefault: applies.orgDefault, todayUsd: spent.today, monthUsd: spent.month, over };
    },
  };
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

function usageParts(s: SpendLimitStatus): string[] {
  return [
    ...(s.limit.dailyUsd !== undefined ? [`${usd(s.todayUsd)} of ${usd(s.limit.dailyUsd)} today`] : []),
    ...(s.limit.monthlyUsd !== undefined ? [`${usd(s.monthUsd)} of ${usd(s.limit.monthlyUsd)} this month`] : []),
  ];
}

export function spendLimitRefusal(s: SpendLimitStatus): string {
  const resets = s.over === "daily" ? "at midnight UTC" : "on the 1st (UTC)";
  return `This has reached its QM spend limit (${usageParts(s).join(", ")}), so I can't run until it resets ${resets}. An admin can raise the limit.`;
}

export function spendLimitNote(s: SpendLimitStatus): string {
  const whose = s.orgDefault ? "the org's per-person default" : "this scope's own limit";
  return `Spend cap here (${whose}): ${usageParts(s).join(", ")}, UTC. At the cap, new turns here are refused until it resets.`;
}
