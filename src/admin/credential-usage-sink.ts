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
}

export function createCredentialUsageSink(): CredentialUsageSink {
  const sink = createTimestampedEventSink<CredentialUsageSample>({
    max: 10000,
    defaultLimit: CREDENTIAL_USAGE_WINDOW,
    equalityFields: ["slug"],
  });
  return {
    ...sink,
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
