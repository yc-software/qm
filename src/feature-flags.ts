import type { DurableMap } from "./persistence/durable-map.ts";
import { orgId as configOrgId } from "./config.ts";
import { scopeId, type ScopeId } from "./types.ts";

export const FEATURE_NAMES = ["command_scoped_credentials"] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

export interface FeatureFlagRecord {
  featureName: FeatureName;
  enabledScopes: ScopeId[];
  updatedAt: number;
  updatedBy: string;
}

export interface FeatureFlagStore {
  list(): Promise<FeatureFlagRecord[]>;
  get(featureName: FeatureName): Promise<FeatureFlagRecord | null>;
  enabled(featureName: FeatureName, scope: ScopeId): Promise<boolean>;
  setEnabled(featureName: FeatureName, scope: ScopeId, on: boolean, updatedBy: string): Promise<FeatureFlagRecord>;
}

export function createFeatureFlagStore(
  backing: DurableMap<FeatureFlagRecord>,
  opts: { now?: () => number } = {},
): FeatureFlagStore {
  const orgScope = scopeId("org", configOrgId());
  const now = opts.now ?? Date.now;
  const key = (featureName: FeatureName) => featureName;
  return {
    list: () => backing.all(),
    get: (featureName) => backing.get(key(featureName)),
    async enabled(featureName, scope) {
      const row = await backing.get(key(featureName));
      return row?.enabledScopes.includes(orgScope) === true || row?.enabledScopes.includes(scope) === true;
    },
    async setEnabled(featureName, scope, on, updatedBy) {
      if (!updatedBy.trim()) throw new Error("feature flag updater must not be empty");
      const current = await backing.get(key(featureName));
      const scopes = new Set(current?.enabledScopes ?? []);
      if (on) scopes.add(scope);
      else scopes.delete(scope);
      const record = {
        featureName,
        enabledScopes: [...scopes].sort(),
        updatedAt: now(),
        updatedBy,
      };
      await backing.put(key(featureName), record);
      return record;
    },
  };
}
