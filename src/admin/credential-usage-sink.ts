import type { ScopeId } from "../types.ts";

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
  admitDailyCall(slug: string, cap: number): Promise<boolean>;
}

export const utcDayStart = (ms: number): number => ms - (ms % 86_400_000);
