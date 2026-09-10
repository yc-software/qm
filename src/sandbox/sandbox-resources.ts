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
  state: "unverified" | "provisioning" | "ready" | "failed" | "retired";
  availableActions?: string[];
  machineId?: string;
  cleanupPending?: boolean;
  spec?: AgentComputerSpec;
  error?: string;
}

export interface SandboxDefault {
  sandboxId: string | null;
}

export interface SandboxResourceRollout {
  activatedAt: string;
}

export interface LegacySandboxBinding {
  scopeId: string;
  backend: SandboxBackendName;
  machineId?: string;
}

export interface SandboxResources {
  initialize(): Promise<void>;
  list(
    actorId: string,
    scopeId: ScopeId,
  ): Promise<{
    sandboxes: SandboxResource[];
    defaultSandboxId: string | null;
    defaultMode: "none" | "selected";
    providers: Array<{ name: SandboxBackendName; spec?: AgentComputerSpec; actions: string[] }>;
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
  withLegacyMutation<T>(scopeId: string, action: () => Promise<T>): Promise<T>;
  recordLegacy(scopeId: string, backend: SandboxBackendName, handle: SandboxHandle): Promise<string>;
}

export function createSandboxResources(opts: {
  enabled: boolean;
  rollout: DurableMap<SandboxResourceRollout>;
  legacyScopes?: () => Promise<string[]>;
  legacySandboxes?: () => Promise<LegacySandboxBinding[]>;
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
  const legacyId = (scopeId: string, backend: SandboxBackendName): string =>
    `legacy-${createHash("sha256").update(`${backend}:${scopeId}`).digest("hex").slice(0, 24)}`;
  let activated = false;
  const isActivated = async (): Promise<boolean> => {
    if (!activated) activated = (await opts.rollout.get("explicit-defaults")) !== null;
    return activated;
  };
  const initialize = async (): Promise<void> => {
    if (await isActivated()) return;
    if (!opts.enabled) return;
    await opts.lock.withLock("sandbox-resources:activation", async () => {
      if (await isActivated()) return;
      const [existing, routes, knownScopes, bindings] = await Promise.all([
        opts.records.all(),
        opts.routes.entries(),
        opts.legacyScopes?.() ?? [],
        opts.legacySandboxes?.() ?? [],
      ]);
      const managedScopes = new Set(existing.filter((record) => !record.legacy).map((record) => record.backingScopeId));
      const valid = (scope: string): boolean => !!parseScopeId(scope).kind && !managedScopes.has(scope);
      const routeBackends = new Map(routes.map(([scope, route]) => [scope, route.backend]));
      const scopes = new Set(
        [
          ...knownScopes,
          ...routes.map(([scope]) => scope),
          ...bindings.map((binding) => binding.scopeId),
          ...existing.map((record) => record.ownerScopeId),
        ].filter(valid),
      );
      const candidates = new Map<string, LegacySandboxBinding>();
      for (const binding of bindings) {
        if (valid(binding.scopeId)) candidates.set(legacyId(binding.scopeId, binding.backend), binding);
      }
      for (const scope of scopes) {
        const backend = routeBackends.get(scope) ?? opts.defaultBackend;
        const id = legacyId(scope, backend);
        if (!candidates.has(id)) candidates.set(id, { scopeId: scope, backend });
      }
      for (const [id, binding] of candidates) {
        await opts.records.putIfAbsent(id, {
          id,
          backend: binding.backend,
          ownerScopeId: binding.scopeId,
          backingScopeId: binding.scopeId,
          name: "Existing scoped computer",
          createdBy: "system",
          createdAt: new Date().toISOString(),
          legacy: true,
          state: "unverified",
          ...(binding.machineId ? { machineId: binding.machineId } : {}),
          ...(opts.backends[binding.backend]?.profile.spec
            ? { spec: opts.backends[binding.backend]!.profile.spec }
            : {}),
        });
      }
      for (const scope of scopes) {
        const id = legacyId(scope, routeBackends.get(scope) ?? opts.defaultBackend);
        const record = await opts.records.get(id);
        await opts.defaults.putIfAbsent(scope, { sandboxId: record?.state === "retired" ? null : id });
      }
      await opts.rollout.put("explicit-defaults", { activatedAt: new Date().toISOString() });
      activated = true;
    });
  };
  const requireEnabled = async (): Promise<void> => {
    if (!opts.enabled) throw new Error("sandbox management is disabled until the resource rollout is enabled");
    await initialize();
  };
  const actionsFor = (backend: Sandbox | undefined): string[] => {
    if (!backend) return [];
    return [
      "create",
      ...(backend.computerStatus ? ["status"] : []),
      ...(backend.restartComputer ? ["restart"] : []),
      ...(backend.destroyScope ? ["retire"] : []),
    ];
  };
  const authorize = async (actorId: string, scopeId: ScopeId): Promise<void> => {
    if (!parseScopeId(scopeId).kind || !(await opts.canUseScope(actorId, scopeId)))
      throw new Error("sandbox access requires permission to use its owning scope");
  };
  const get = async (id: string): Promise<SandboxResource> => {
    await initialize();
    const record = await opts.records.get(id);
    if (!record) throw new Error(`sandbox not found: ${id}`);
    return record;
  };
  const use = <T>(id: string, action: () => Promise<T>): Promise<T> =>
    opts.lock.withLock(`sandbox-resource:${id}`, async () => {
      const record = await get(id);
      if (record.state === "retired") throw new Error("sandbox has been retired");
      return action();
    });
  const recordLegacy = async (scopeId: string, backend: SandboxBackendName, handle: SandboxHandle): Promise<string> => {
    const id = legacyId(scopeId, backend);
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
    if (await isActivated()) await opts.defaults.putIfAbsent(scopeId, { sandboxId: id });
    return id;
  };
  return {
    initialize,
    get,
    recordLegacy: (scopeId, backend, handle) =>
      opts.lock.withLock("sandbox-resources:activation", () => recordLegacy(scopeId, backend, handle)),
    async withLegacyMutation(scopeId, action) {
      await initialize();
      return opts.lock.withLock("sandbox-resources:activation", async () => {
        if ((await isActivated()) || (await opts.defaults.get(scopeId)))
          throw new Error(
            "sandbox migration is retired for explicit defaults; create a sandbox and set its default instead",
          );
        return action();
      });
    },
    use,
    async retire(actorId, id) {
      await requireEnabled();
      const record = await get(id);
      await authorize(actorId, record.ownerScopeId);
      await opts.lock.withLock(`sandbox-resource:${id}`, () =>
        opts.lock.withLock(`sandbox-default:${record.ownerScopeId}`, async () => {
          const current = await get(id);
          if (current.state === "retired" && !current.cleanupPending && !current.error) return;
          const selected = await opts.defaults.get(current.ownerScopeId);
          const legacyBackend = (await opts.routes.get(current.ownerScopeId))?.backend ?? opts.defaultBackend;
          if (selected?.sandboxId === id || (!selected && current.legacy && current.backend === legacyBackend))
            throw new Error("unset or change this scope's default before retiring its computer");
          await opts.beforeRetire?.(current);
          const backend = opts.backends[current.backend];
          if (!backend?.destroyScope) throw new Error(`sandbox retirement unavailable: ${current.backend}`);
          const retiring = { ...current, state: "retired" as const, cleanupPending: true };
          await opts.records.put(id, retiring);
          try {
            await backend.destroyScope(current.backingScopeId);
            await opts.records.put(id, { ...retiring, cleanupPending: false, error: undefined });
          } catch (error) {
            await opts.records.put(id, { ...retiring, error: String(error) });
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
      return use(id, () => backend.computerStatus!(record.backingScopeId));
    },
    async restart(actorId, id) {
      await requireEnabled();
      const record = await get(id);
      if (record.state === "retired") throw new Error("sandbox has been retired");
      await authorize(actorId, record.ownerScopeId);
      const backend = opts.backends[record.backend];
      if (!backend?.restartComputer) throw new Error(`sandbox restart unavailable: ${record.backend}`);
      await use(id, () => backend.restartComputer!(record.backingScopeId));
    },
    async resolve(scopeId) {
      await initialize();
      const route = await opts.defaults.get(scopeId);
      if (!route) return (await isActivated()) ? null : undefined;
      return route.sandboxId === null ? null : get(route.sandboxId);
    },
    async list(actorId, scopeId) {
      await authorize(actorId, scopeId);
      await initialize();
      const route = await opts.defaults.get(scopeId);
      const sandboxes: SandboxResource[] = [];
      for (const record of await opts.records.all()) {
        if (!(await opts.canUseScope(actorId, record.ownerScopeId))) continue;
        const backend = opts.backends[record.backend];
        let availableActions = actionsFor(backend).filter((action) => action !== "create");
        if (record.state === "retired")
          availableActions = (record.cleanupPending || record.error) && backend?.destroyScope ? ["retire"] : [];
        sandboxes.push({ ...record, availableActions });
      }
      const providers = (Object.entries(opts.backends) as Array<[SandboxBackendName, Sandbox]>)
        .filter(([, backend]) => !!backend)
        .map(([name, backend]) => ({
          name,
          ...(backend.profile.spec ? { spec: backend.profile.spec } : {}),
          actions: actionsFor(backend),
        }));
      return {
        sandboxes,
        defaultSandboxId: route?.sandboxId ?? null,
        defaultMode: route?.sandboxId ? "selected" : "none",
        providers,
      };
    },
    async create(actorId, scopeId, backend, name) {
      await requireEnabled();
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
      return opts.lock.withLock(`sandbox-resource:${id}`, async () => {
        await opts.records.put(id, record);
        const sandbox = opts.backends[record.backend]!;
        try {
          const handle = await sandbox.provision(
            [{ scopeId: record.backingScopeId, mountPath: "/", mode: "rw" }],
            await opts.provisionOptions?.(scopeId),
          );
          const ready: SandboxResource = {
            ...record,
            state: "ready",
            machineId: handle.id,
            spec: sandbox.profile.spec,
          };
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
      });
    },
    async setDefault(actorId, scopeId, id) {
      await requireEnabled();
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
