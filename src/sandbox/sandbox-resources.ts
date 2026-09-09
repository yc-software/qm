import { randomUUID, createHash } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { parseScopeId, type ScopeId } from "../types.ts";
import type { SandboxBackendName, SandboxRoute } from "./sandbox-routing.ts";
import type { Sandbox, SandboxHandle, AgentComputerSpec, ProvisionOptions, ComputerStatus } from "./sandbox.ts";

export interface SandboxResource {
  id: string;
  backend: SandboxBackendName;
  ownerScopeId: ScopeId;
  backingScopeId: string;
  name: string;
  createdBy: string;
  createdAt: string;
  legacy: boolean;
  state: "provisioning" | "ready" | "failed" | "retired";
  machineId?: string;
  spec?: AgentComputerSpec;
  error?: string;
}

export interface SandboxDefault {
  sandboxId: string | null;
}

export interface SandboxResources {
  list(
    actorId: string,
    scopeId: ScopeId,
  ): Promise<{
    sandboxes: SandboxResource[];
    defaultSandboxId: string | null;
    defaultMode: "legacy" | "none" | "selected";
  }>;
  create(actorId: string, scopeId: ScopeId, backend: string, name?: string): Promise<SandboxResource>;
  access(actorId: string, id: string): Promise<SandboxResource>;
  status(actorId: string, id: string): Promise<ComputerStatus>;
  restart(actorId: string, id: string): Promise<void>;
  retire(actorId: string, id: string): Promise<void>;
  use<T>(id: string, action: () => Promise<T>): Promise<T>;
  setDefault(actorId: string, scopeId: ScopeId, id: string | null): Promise<void>;
  resolve(scopeId: ScopeId): Promise<SandboxResource | null | undefined>;
  get(id: string): Promise<SandboxResource>;
  recordLegacy(scopeId: string, backend: SandboxBackendName, handle: SandboxHandle): Promise<string>;
}

export function createSandboxResources(opts: {
  records: DurableMap<SandboxResource>;
  defaults: DurableMap<SandboxDefault>;
  routes: DurableMap<SandboxRoute>;
  backends: Partial<Record<SandboxBackendName, Sandbox>>;
  defaultBackend: SandboxBackendName;
  provisionOptions?: (scopeId: string) => Promise<ProvisionOptions>;
  beforeDefaultChange?: (scopeId: string) => Promise<void>;
  beforeRetire?: (record: SandboxResource) => Promise<void>;
  lock: AdvisoryLock;
  canUseScope(actorId: string, scopeId: ScopeId): Promise<boolean>;
}): SandboxResources {
  const authorize = async (actorId: string, scopeId: ScopeId): Promise<void> => {
    if (!parseScopeId(scopeId).kind || !(await opts.canUseScope(actorId, scopeId)))
      throw new Error("sandbox access requires permission to use its owning scope");
  };
  const get = async (id: string): Promise<SandboxResource> => {
    const record = await opts.records.get(id);
    if (!record) throw new Error(`sandbox not found: ${id}`);
    return record;
  };
  return {
    get,
    async recordLegacy(scopeId, backend, handle) {
      const id = `legacy-${createHash("sha256").update(`${backend}:${scopeId}`).digest("hex").slice(0, 24)}`;
      await opts.records.putIfAbsent(id, {
        id,
        backend,
        ownerScopeId: scopeId,
        backingScopeId: scopeId,
        name: "Existing scoped computer",
        createdBy: "system",
        createdAt: new Date().toISOString(),
        legacy: true,
        state: "ready",
        machineId: handle.id,
        spec: opts.backends[backend]?.profile.spec,
      });
      return id;
    },
    async use(id, action) {
      return opts.lock.withLock(`sandbox-resource:${id}`, async () => {
        const record = await get(id);
        if (record.state === "retired") throw new Error("sandbox has been retired");
        return action();
      });
    },
    async retire(actorId, id) {
      const record = await get(id);
      await authorize(actorId, record.ownerScopeId);
      await opts.lock.withLock(`sandbox-resource:${id}`, () =>
        opts.lock.withLock(`sandbox-default:${record.ownerScopeId}`, async () => {
          const current = await get(id);
          if (current.state === "retired") throw new Error("sandbox has already been retired");
          const selected = await opts.defaults.get(current.ownerScopeId);
          const legacyBackend = (await opts.routes.get(current.ownerScopeId))?.backend ?? opts.defaultBackend;
          if (selected?.sandboxId === id || (!selected && current.legacy && current.backend === legacyBackend))
            throw new Error("unset or change this scope's default before retiring its computer");
          await opts.beforeRetire?.(current);
          const backend = opts.backends[current.backend];
          if (!backend) throw new Error(`sandbox backend unavailable: ${current.backend}`);
          const handle = await backend.provision(
            [{ scopeId: current.backingScopeId, mountPath: "/", mode: "rw" }],
            await opts.provisionOptions?.(current.ownerScopeId),
          );
          if (
            backend.listProcesses &&
            (await backend.listProcesses(handle)).some((process) => process.status.state === "running")
          )
            throw new Error("stop this sandbox's processes before retiring it");
          await opts.records.put(id, { ...current, state: "retired" });
          try {
            await backend.teardown(handle, { destroy: true });
            if (backend.computerStatus && (await backend.computerStatus(current.backingScopeId)).provisioned === true)
              throw new Error(
                "sandbox retired from routing but provider still reports a machine; cleanup requires attention",
              );
          } catch (error) {
            await opts.records.put(id, { ...current, state: "retired", error: String(error) });
            throw error;
          }
        }),
      );
    },
    async access(actorId, id) {
      const record = await get(id);
      await authorize(actorId, record.ownerScopeId);
      return record;
    },
    async status(actorId, id) {
      const record = await get(id);
      await authorize(actorId, record.ownerScopeId);
      const backend = opts.backends[record.backend];
      if (!backend?.computerStatus) throw new Error(`sandbox status unavailable: ${record.backend}`);
      return backend.computerStatus(record.backingScopeId);
    },
    async restart(actorId, id) {
      const record = await get(id);
      if (record.state === "retired") throw new Error("sandbox has been retired");
      await authorize(actorId, record.ownerScopeId);
      const backend = opts.backends[record.backend];
      if (!backend?.restartComputer) throw new Error(`sandbox restart unavailable: ${record.backend}`);
      await backend.restartComputer(record.backingScopeId);
    },
    async resolve(scopeId) {
      const route = await opts.defaults.get(scopeId);
      if (!route) return undefined;
      return route.sandboxId === null ? null : get(route.sandboxId);
    },
    async list(actorId, scopeId) {
      await authorize(actorId, scopeId);
      const route = await opts.defaults.get(scopeId);
      const backend = (await opts.routes.get(scopeId))?.backend ?? opts.defaultBackend;
      const legacyId = `legacy-${createHash("sha256").update(`${backend}:${scopeId}`).digest("hex").slice(0, 24)}`;
      const legacy = route ? null : await opts.records.get(legacyId);
      const sandboxes: SandboxResource[] = [];
      for (const record of await opts.records.all()) {
        if (await opts.canUseScope(actorId, record.ownerScopeId)) sandboxes.push(record);
      }
      let defaultMode: "legacy" | "none" | "selected" = "legacy";
      if (route) defaultMode = route.sandboxId === null ? "none" : "selected";
      return { sandboxes, defaultSandboxId: route?.sandboxId ?? (route ? null : (legacy?.id ?? null)), defaultMode };
    },
    async create(actorId, scopeId, backend, name) {
      await authorize(actorId, scopeId);
      if (!Object.hasOwn(opts.backends, backend) || !opts.backends[backend as SandboxBackendName])
        throw new Error(`sandbox backend unavailable: ${backend}`);
      const id = randomUUID();
      const record: SandboxResource = {
        id,
        backend: backend as SandboxBackendName,
        ownerScopeId: scopeId,
        backingScopeId: `sandbox-${id}`,
        name: name?.trim().slice(0, 120) || backend,
        createdBy: actorId,
        createdAt: new Date().toISOString(),
        legacy: false,
        state: "provisioning",
      };
      await opts.records.put(id, record);
      const sandbox = opts.backends[record.backend]!;
      try {
        const handle = await sandbox.provision(
          [{ scopeId: record.backingScopeId, mountPath: "/", mode: "rw" }],
          await opts.provisionOptions?.(scopeId),
        );
        const ready: SandboxResource = { ...record, state: "ready", machineId: handle.id, spec: sandbox.profile.spec };
        await opts.records.put(id, ready);
        return ready;
      } catch (error) {
        await opts.records.put(id, {
          ...record,
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    async setDefault(actorId, scopeId, id) {
      await authorize(actorId, scopeId);
      await opts.lock.withLock(`sandbox-default:${scopeId}`, async () => {
        if (id !== null) {
          const record = await get(id);
          await authorize(actorId, record.ownerScopeId);
          if (record.state === "retired") throw new Error("sandbox has been retired");
          if (record.ownerScopeId !== scopeId)
            throw new Error(
              "the default sandbox must belong to this scope; use sandbox_id for another authorized scope",
            );
        }
        await opts.beforeDefaultChange?.(scopeId);
        await opts.defaults.put(scopeId, { sandboxId: id });
      });
    },
  };
}
