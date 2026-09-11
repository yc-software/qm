import { orgId as configOrgId } from "../config.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { scopeId, type ScopeId } from "../types.ts";
import { randomUUID } from "node:crypto";

export const DEVICE_FLOW_CUTOVER_MODES = ["legacy", "prefer_ephemeral", "ephemeral_only"] as const;

export type DeviceFlowCutoverMode = (typeof DEVICE_FLOW_CUTOVER_MODES)[number];

export interface DeviceFlowCutoverPolicy {
  scopeId: ScopeId;
  service: string;
  mode: DeviceFlowCutoverMode;
  updatedAt: number;
  updatedBy: string;
  resetResident?: boolean;
  resetGeneration?: string;
}

export interface DeviceFlowCutoverReset {
  generation: string;
}

export interface DeviceFlowCutoverStore {
  listServices(scope: ScopeId): Promise<string[]>;
  get(scope: ScopeId, service: string): Promise<DeviceFlowCutoverPolicy | null>;
  resolvePolicy(scope: ScopeId, service: string): Promise<DeviceFlowCutoverPolicy | null>;
  resolve(scope: ScopeId, service: string): Promise<DeviceFlowCutoverMode>;
  residentResetGeneration(scope: ScopeId, service: string, computerId?: string): Promise<string | null>;
  markResidentReset(scope: ScopeId, service: string, generation: string, computerId?: string): Promise<void>;
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
  opts: { now?: () => number; resetId?: () => string; resets?: DurableMap<DeviceFlowCutoverReset> } = {},
): DeviceFlowCutoverStore {
  const orgScope = scopeId("org", configOrgId());
  const now = opts.now ?? Date.now;
  const resetId = opts.resetId ?? randomUUID;
  const resets = opts.resets;
  const volatileResets = new Map<string, DeviceFlowCutoverReset>();
  const resetKey = (kind: "request" | "complete", scope: ScopeId, service: string): string =>
    `${kind}:${policyKey(scope, service)}`;
  const completionKey = (scope: ScopeId, service: string, computerId?: string): string =>
    `${resetKey("complete", scope, service)}${computerId ? `:${encodeURIComponent(computerId)}` : ""}`;
  const getReset = (key: string): Promise<DeviceFlowCutoverReset | null> =>
    resets ? resets.get(key) : Promise.resolve(volatileResets.get(key) ?? null);
  const putReset = async (key: string, value: DeviceFlowCutoverReset): Promise<void> => {
    if (resets) await resets.put(key, value);
    else volatileResets.set(key, value);
  };

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
      const requests = resets ? await resets.entries() : [...volatileResets.entries()];
      for (const [key] of requests) {
        for (const target of new Set([scope, orgScope])) {
          const prefix = `request:${encodeURIComponent(target)}:`;
          if (key.startsWith(prefix)) services.add(decodeURIComponent(key.slice(prefix.length)));
        }
      }
      return [...services].sort();
    },
    get,
    resolvePolicy,
    resolve,
    async residentResetGeneration(scope, service, computerId) {
      if ((await resolve(scope, service)) !== "legacy") return null;
      const policy = await resolvePolicy(scope, service);
      const requested = await getReset(resetKey("request", scope, service));
      const orgRequested = scope === orgScope ? null : await getReset(resetKey("request", orgScope, service));
      const generation = [
        policy?.resetResident ? policy.resetGeneration : undefined,
        orgRequested?.generation,
        requested?.generation,
      ]
        .filter(Boolean)
        .join("|");
      if (!generation) return null;
      const complete = await getReset(completionKey(scope, service, computerId));
      return complete?.generation === generation ? null : generation;
    },
    async markResidentReset(scope, service, generation, computerId) {
      if (generation) await putReset(completionKey(scope, service, computerId), { generation });
    },
    async set(scope, service, mode, updatedBy) {
      assertMode(mode);
      const normalized = normalizedService(service);
      if (!updatedBy.trim()) throw new Error("device-flow cutover updater must not be empty");
      const previous = await resolve(scope, normalized);
      const record = {
        scopeId: scope,
        service: normalized,
        mode,
        updatedAt: now(),
        updatedBy,
        ...(mode === "legacy" && previous !== "legacy" ? { resetResident: true, resetGeneration: resetId() } : {}),
      };
      await backing.put(policyKey(scope, normalized), record);
      return record;
    },
    async clear(scope, service) {
      const previous = await resolve(scope, service);
      const inherited = scope === orgScope ? "legacy" : ((await get(orgScope, service))?.mode ?? "legacy");
      if (previous !== "legacy" && inherited === "legacy") {
        await putReset(resetKey("request", scope, service), { generation: resetId() });
      }
      await backing.delete(policyKey(scope, service));
    },
  };
}
