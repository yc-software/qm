import type { ScopeId } from "../types.ts";
import { createTimestampedEventSink } from "./scoped-event-sink.ts";

export interface CredentialUsageSample {
  ts: number;
  slug: string;
  host: string;
  status: string;
  upstreamStatus?: number;
  scopeLabel: ScopeId;
  principalId: string;
}

interface CredentialUsageQuery {
  scopeId?: string;
  slug?: string;
  since?: number;
  limit?: number;
}

export const CREDENTIAL_USAGE_WINDOW = 5000;

interface CredentialUsageSummary {
  slug: string;
  usageCount: number;
  usageTruncated: boolean;
  usageSince: number | null;
  lastUsedAt: number | null;
  recentUsagePrincipals: string[];
}

export interface CredentialUsageSink {
  record(s: Omit<CredentialUsageSample, "ts">): void;
  list(opts?: CredentialUsageQuery): Promise<CredentialUsageSample[]>;
  summary(slugs: readonly string[]): Promise<CredentialUsageSummary[]>;
  sentSince(slug: string, since: number): Promise<number>;
  admitDailyCall(slug: string, cap: number): Promise<boolean>;
}

const DAY_MS = 86_400_000;

export function dailyCallAdmission(
  sentSince: (slug: string, since: number) => Promise<number>,
  now: () => number = Date.now,
): (slug: string, cap: number) => Promise<boolean> {
  const days = new Map<string, { day: number; tally: Promise<{ sent: number }> }>();
  return async (slug, cap) => {
    const day = Math.floor(now() / DAY_MS) * DAY_MS;
    let entry = days.get(slug);
    if (entry?.day !== day) {
      const fresh = { day, tally: sentSince(slug, day).then((sent) => ({ sent })) };
      fresh.tally.catch(() => {
        if (days.get(slug) === fresh) days.delete(slug);
      });
      days.set(slug, fresh);
      entry = fresh;
    }
    const tally = await entry.tally;
    if (tally.sent >= cap) return false;
    tally.sent += 1;
    return true;
  };
}

export function createCredentialUsageSink(now: () => number = Date.now): CredentialUsageSink {
  const sink = createTimestampedEventSink<CredentialUsageSample>({
    max: 10000,
    defaultLimit: CREDENTIAL_USAGE_WINDOW,
    equalityFields: ["slug"],
  });
  const sentSince = async (slug: string, since: number) =>
    (await sink.list({ slug, since, limit: Number.MAX_SAFE_INTEGER })).filter((event) => event.status !== "denied")
      .length;
  return {
    ...sink,
    sentSince,
    admitDailyCall: dailyCallAdmission(sentSince, now),
    async summary(slugs) {
      return Promise.all(
        [...new Set(slugs)].map(async (slug) => {
          const recent = await sink.list({ slug, limit: CREDENTIAL_USAGE_WINDOW });
          const successful = recent.filter((event) => event.status === "ok");
          return {
            slug,
            usageCount: successful.length,
            usageTruncated: recent.length === CREDENTIAL_USAGE_WINDOW,
            usageSince: successful.length ? Math.min(...successful.map((event) => event.ts)) : null,
            lastUsedAt: successful.length ? Math.max(...successful.map((event) => event.ts)) : null,
            recentUsagePrincipals: [...new Set(successful.map((event) => event.principalId))].slice(0, 12),
          };
        }),
      );
    },
  };
}
