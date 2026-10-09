import { orgId as configOrgId } from "../config.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { scopeId, type ScopeId } from "../types.ts";

export const DEVICE_FLOW_CUTOVER_MODES = ["legacy", "prefer_ephemeral", "ephemeral_only"] as const;

export type DeviceFlowCutoverMode = (typeof DEVICE_FLOW_CUTOVER_MODES)[number];

export interface DeviceFlowCutoverPolicy {
  scopeId: ScopeId;
  service: string;
  mode: DeviceFlowCutoverMode;
  updatedAt: number;
  updatedBy: string;
}

export interface DeviceFlowCutoverStore {
  listServices(scope: ScopeId): Promise<string[]>;
  get(scope: ScopeId, service: string): Promise<DeviceFlowCutoverPolicy | null>;
  resolvePolicy(scope: ScopeId, service: string): Promise<DeviceFlowCutoverPolicy | null>;
  resolve(scope: ScopeId, service: string): Promise<DeviceFlowCutoverMode>;
  set(
    scope: ScopeId,
    service: string,
    mode: DeviceFlowCutoverMode,
    updatedBy: string,
  ): Promise<DeviceFlowCutoverPolicy>;
  clear(scope: ScopeId, service: string): Promise<void>;
}

function normalizedService(service: string): string {
  const normalized = service.trim().toLowerCase();
  if (!normalized) throw new Error("device-flow cutover service must not be empty");
  return normalized;
}

function policyKey(scope: ScopeId, service: string): string {
  return `${encodeURIComponent(scope)}:${encodeURIComponent(normalizedService(service))}`;
}

function assertMode(mode: string): asserts mode is DeviceFlowCutoverMode {
  if (!(DEVICE_FLOW_CUTOVER_MODES as readonly string[]).includes(mode)) {
    throw new Error(`invalid device-flow cutover mode: ${mode}`);
  }
}

export function createDeviceFlowCutoverStore(
  backing: DurableMap<DeviceFlowCutoverPolicy>,
  opts: { now?: () => number } = {},
): DeviceFlowCutoverStore {
  const orgScope = scopeId("org", configOrgId());
  const now = opts.now ?? Date.now;

  const get = async (scope: ScopeId, service: string): Promise<DeviceFlowCutoverPolicy | null> => {
    const record = await backing.get(policyKey(scope, service));
    if (!record) return null;
    assertMode(record.mode);
    return record;
  };
  const resolvePolicy = async (scope: ScopeId, service: string): Promise<DeviceFlowCutoverPolicy | null> => {
    const exact = await get(scope, service);
    if (exact) return exact;
    return scope === orgScope ? null : get(orgScope, service);
  };
  const resolve = async (scope: ScopeId, service: string): Promise<DeviceFlowCutoverMode> =>
    (await resolvePolicy(scope, service))?.mode ?? "legacy";

  return {
    async listServices(scope) {
      const services = new Set(
        (await backing.all())
          .filter((record) => record.scopeId === scope || record.scopeId === orgScope)
          .map((record) => record.service),
      );
      return [...services].sort();
    },
    get,
    resolvePolicy,
    resolve,
    async set(scope, service, mode, updatedBy) {
      assertMode(mode);
      const normalized = normalizedService(service);
      if (!updatedBy.trim()) throw new Error("device-flow cutover updater must not be empty");
      const record = {
        scopeId: scope,
        service: normalized,
        mode,
        updatedAt: now(),
        updatedBy,
      };
      await backing.put(policyKey(scope, normalized), record);
      return record;
    },
    async clear(scope, service) {
      await backing.delete(policyKey(scope, service));
    },
  };
}
