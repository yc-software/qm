import type { SandboxResources } from "./sandbox-resources.ts";
import { parseScopeId, type ScopeKind, type WorkspaceLayer } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { swallow, swallowAs } from "../util/errors.ts";
import {
  CapabilityUnsupportedError,
  supportsBlobStaging,
  supportsProcessSessions,
  type AgentComputerProfile,
  type ExecOptions,
  type ExecResult,
  type ProvisionOptions,
  type Sandbox,
  type SandboxHandle,
  type SandboxExecutionMode,
  type StageOptions,
  type TeardownOptions,
} from "./sandbox.ts";

export type SandboxBackendName =
  "sprites" | "aws" | "local" | "smolmachines" | "e2b" | "modal" | "porter" | "agent37" | "superserve";

export type SandboxScopeDefaults = Partial<Record<ScopeKind, SandboxBackendName>>;

export function sandboxDefaultForScope(
  scope: string | undefined,
  fallback: SandboxBackendName,
  defaults?: SandboxScopeDefaults,
): SandboxBackendName {
  const kind = scope ? parseScopeId(scope).kind : null;
  return (kind && defaults?.[kind]) || fallback;
}

export interface SandboxRoute {
  backend: SandboxBackendName;
  migratedAt?: string;
  migrationSha?: string;
  capabilitiesLost?: string[];
  pinned?: boolean;
  reason?: string;
}

export interface RoutingSandboxOptions {
  backends: Partial<Record<SandboxBackendName, Sandbox>>;
  isolatedBackends?: Partial<Record<SandboxBackendName, Sandbox>>;
  executionBindings?: DurableMap<SandboxExecutionBinding>;
  routes: DurableMap<SandboxRoute>;
  defaultBackend: SandboxBackendName;
  scopeDefaults?: SandboxScopeDefaults;
  resources?: SandboxResources;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export interface SandboxExecutionBinding {
  executionMode: SandboxExecutionMode;
  resourceId?: string;
  scopeId?: string;
}

export const ROUTE_CACHE_TTL_MS = 15_000;

export function createSandboxRouter(opts: RoutingSandboxOptions): Sandbox {
  const { backends, routes, defaultBackend } = opts;
  const fallback = ((): Sandbox => {
    const s = backends[defaultBackend];
    if (!s) throw new Error(`sandbox router: default backend ${defaultBackend} is not constructed`);
    return s;
  })();

  const routeCache = new Map<string, { route: SandboxRoute | null; at: number }>();
  async function routeFor(scopeId: string): Promise<SandboxRoute | null> {
    const hit = routeCache.get(scopeId);
    if (hit && Date.now() - hit.at < ROUTE_CACHE_TTL_MS) return hit.route;
    const route = (await routes.get(scopeId)) ?? null;
    routeCache.set(scopeId, { route, at: Date.now() });
    return route;
  }

  async function pick(scopeId: string): Promise<{ name: SandboxBackendName; sandbox: Sandbox }> {
    const route = await routeFor(scopeId);
    const name = route?.backend ?? sandboxDefaultForScope(scopeId, defaultBackend, opts.scopeDefaults);
    const sandbox = backends[name];
    if (sandbox) return { name, sandbox };
    opts.onError?.({
      category: "sandbox_routing",
      code: "backend_unavailable",
      message: `scope routed to ${name} but that backend is not constructed here; refusing a substitute computer`,
      scopeLabel: scopeId,
    });
    throw new Error(`sandbox backend unavailable: ${name}; refusing to use a substitute computer`);
  }

  const forMode = (name: SandboxBackendName, mode: SandboxExecutionMode): Sandbox => {
    const sandbox = (mode === "isolated" ? opts.isolatedBackends : backends)?.[name];
    if (!sandbox) throw new Error(`sandbox backend unavailable: ${name} (${mode})`);
    return sandbox;
  };

  const useHandle = async <T>(
    handle: SandboxHandle,
    action: (sandbox: Sandbox, handle: SandboxHandle) => Promise<T>,
    exclusive = false,
  ): Promise<T> => {
    const name = (handle.backend ?? defaultBackend) as SandboxBackendName;
    const binding = await opts.executionBindings?.get(`${name}:${handle.id}`);
    const resourceId = binding?.resourceId ?? handle.resourceId;
    const resource = resourceId ? await opts.resources?.get(resourceId) : undefined;
    if (resource && resource.backend !== name) throw new Error("sandbox backend does not match its resource");
    const mode = binding?.executionMode ?? resource?.executionMode ?? "legacy";
    if (resource && mode !== (resource.executionMode ?? "legacy"))
      throw new Error("sandbox execution mode does not match its resource");
    const resolved = {
      ...handle,
      backend: name,
      executionMode: mode,
      ...(resourceId ? { resourceId } : {}),
      ...(binding?.scopeId ? { scopeId: binding.scopeId } : {}),
    };
    const run = () => action(forMode(name, mode), resolved);
    return resourceId && opts.resources ? opts.resources.use(resourceId, run, exclusive) : run();
  };

  const bind = async (handle: SandboxHandle): Promise<SandboxHandle> => {
    if (handle.executionMode === "isolated" && !opts.executionBindings)
      throw new Error("isolated sandbox requires durable execution bindings");
    if (opts.executionBindings) {
      const existing = await opts.executionBindings.putIfAbsent(`${handle.backend}:${handle.id}`, {
        executionMode: handle.executionMode ?? "legacy",
        ...(handle.resourceId ? { resourceId: handle.resourceId } : {}),
        ...(handle.scopeId ? { scopeId: handle.scopeId } : {}),
      });
      if (existing.executionMode !== handle.executionMode || existing.resourceId !== handle.resourceId)
        throw new Error("sandbox execution binding cannot change");
    }
    return handle;
  };

  async function computerTarget(scopeId: string): Promise<{ sandbox: Sandbox; scopeId: string; resourceId?: string }> {
    const resource = await opts.resources?.resolve(scopeId);
    if (resource === null) throw new Error("this scope has no default sandbox");
    if (resource) {
      const sandbox = forMode(resource.backend, resource.executionMode ?? "legacy");
      return { sandbox, scopeId: resource.backingScopeId, resourceId: resource.id };
    }
    return { sandbox: await pickStrict(scopeId), scopeId };
  }

  async function pickStrict(scopeId: string): Promise<Sandbox> {
    const route = await routeFor(scopeId);
    const name = route?.backend ?? sandboxDefaultForScope(scopeId, defaultBackend, opts.scopeDefaults);
    const sandbox = backends[name];
    if (!sandbox) {
      throw new Error(
        `scope ${scopeId} is routed to ${name}, which is not constructed here — refusing to act on a substitute computer`,
      );
    }
    return sandbox;
  }

  const reportedGaps = new Set<string>();
  const requireCap = <K extends keyof Sandbox>(
    s: Sandbox,
    cap: K,
    scopeLabel?: string,
  ): Sandbox & Required<Pick<Sandbox, K>> => {
    if (typeof s[cap] !== "function") {
      const refusal = new CapabilityUnsupportedError(s.profile.backend, String(cap));
      const gap = `${s.profile.backend}:${String(cap)}`;
      if (!reportedGaps.has(gap)) {
        reportedGaps.add(gap);
        try {
          opts.onError?.({
            category: "sandbox_routing",
            code: "capability_unsupported",
            message: refusal.message,
            ...(scopeLabel ? { scopeLabel } : {}),
          });
        } catch (e) {
          swallow("sandbox routing: capability gap report", e);
        }
      }
      throw refusal;
    }
    return s as Sandbox & Required<Pick<Sandbox, K>>;
  };
  const some = (pred: (s: Sandbox) => boolean): boolean =>
    [...constructed(backends), ...constructed(opts.isolatedBackends ?? {})].some(pred);

  const router: Sandbox = {
    profile: fallback.profile,

    async executionModeFor(scopeId, sandboxId) {
      const resource = sandboxId ? await opts.resources?.get(sandboxId) : await opts.resources?.resolve(scopeId);
      if (sandboxId && !resource) throw new Error("sandbox inventory unavailable");
      return resource?.executionMode ?? "legacy";
    },

    async profileFor(scopeId: string, sandboxId?: string): Promise<AgentComputerProfile> {
      const resource = sandboxId ? await opts.resources?.get(sandboxId) : await opts.resources?.resolve(scopeId);
      if (sandboxId && !resource) throw new Error("sandbox inventory unavailable");
      if (resource) {
        const sandbox = forMode(resource.backend, resource.executionMode ?? "legacy");
        return sandbox.profile;
      }
      if (resource === null) return fallback.profile;
      return (await pick(scopeId)).sandbox.profile;
    },

    async provision(layers: WorkspaceLayer[], provOpts?: ProvisionOptions): Promise<SandboxHandle> {
      const scope = provOpts?.routeScopeId ?? writableScope(layers);
      let resource;
      if (provOpts?.sandboxId) resource = await opts.resources?.get(provOpts.sandboxId);
      else if (!provOpts?.scratch) resource = await opts.resources?.resolve(scope);
      if (provOpts?.sandboxId && !resource) throw new Error("sandbox inventory unavailable");
      if (resource === null) throw new Error("this scope has no default sandbox; create one or specify sandbox_id");
      if (resource) {
        const executionMode = resource.executionMode ?? "legacy";
        if (provOpts?.executionMode !== undefined && provOpts.executionMode !== executionMode)
          throw new Error("sandbox execution mode cannot change");
        const sandbox = forMode(resource.backend, executionMode);
        const routedLayers = layers.map((layer) =>
          layer.mode === "rw" ? { ...layer, scopeId: resource.backingScopeId } : layer,
        );
        const handle = await opts.resources!.use(
          resource.id,
          () => sandbox.provision(routedLayers, { ...provOpts, executionMode }),
          true,
        );
        return bind({
          ...handle,
          executionMode,
          backend: resource.backend,
          scopeId: resource.ownerScopeId,
          resourceId: resource.id,
        });
      }
      const executionMode = provOpts?.scratch ? await router.executionModeFor!(scope) : "legacy";
      if (provOpts?.executionMode !== undefined && provOpts.executionMode !== executionMode)
        throw new Error("sandbox execution mode must match its owning computer");
      const { name } = await pick(scope);
      const sandbox = forMode(name, executionMode);
      const handle = await sandbox.provision(layers, {
        ...provOpts,
        executionMode,
        ...(provOpts?.scratch && executionMode === "isolated"
          ? { scratch: { key: `isolated:${provOpts.scratch.key}` } }
          : {}),
      });
      const resourceId =
        !provOpts?.scratch && scope ? await opts.resources?.recordLegacy(scope, name, handle) : undefined;
      return bind({
        ...handle,
        executionMode,
        backend: name,
        ...(scope ? { scopeId: scope } : {}),
        ...(resourceId ? { resourceId } : {}),
      });
    },

    run(handle, command, execOpts?: ExecOptions): Promise<ExecResult> {
      return useHandle(handle, (sandbox, resolved) => sandbox.run(resolved, command, execOpts));
    },
    readFile(handle, relPath) {
      return useHandle(handle, (sandbox, resolved) => sandbox.readFile(resolved, relPath));
    },
    writeFile(handle, relPath, data) {
      return useHandle(handle, (sandbox, resolved) => sandbox.writeFile(resolved, relPath, data));
    },
    writeFileBytes(handle, relPath, data) {
      return useHandle(handle, (sandbox, resolved) => sandbox.writeFileBytes(resolved, relPath, data));
    },
    readFileBytes(handle, relPath) {
      return useHandle(handle, (sandbox, resolved) => sandbox.readFileBytes(resolved, relPath));
    },
    listDir(handle, relDir) {
      return useHandle(handle, (sandbox, resolved) => sandbox.listDir(resolved, relDir));
    },
    removeDir(handle, relDir) {
      return useHandle(handle, (sandbox, resolved) => sandbox.removeDir(resolved, relDir));
    },
    removeDirAndList(handle, removeRelDir, listRelDir) {
      return useHandle(handle, async (sandbox, resolved) => {
        if (sandbox.removeDirAndList) return sandbox.removeDirAndList(resolved, removeRelDir, listRelDir);
        await sandbox.removeDir(resolved, removeRelDir);
        return sandbox.listDir(resolved, listRelDir);
      });
    },
    teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      return useHandle(
        handle,
        (sandbox, resolved) => sandbox.teardown(resolved, tdOpts),
        handle.backend !== "modal" || !!tdOpts?.destroy,
      );
    },

    ...(some(supportsProcessSessions)
      ? {
          startRegisteredProcess: (handle: SandboxHandle, command: string, register, o?) =>
            useHandle(handle, async (backend, handle) => {
              const sandbox = requireCap(backend, "startProcess", handle.scopeId);
              const started = await sandbox.startProcess(handle, command, o);
              try {
                await register(started.processId);
              } catch (error) {
                try {
                  await requireCap(sandbox, "signalProcess", handle.scopeId).signalProcess(
                    handle,
                    started.processId,
                    "KILL",
                  );
                } catch (cleanupError) {
                  throw new AggregateError([error, cleanupError], "process registration failed and cleanup failed", {
                    cause: cleanupError,
                  });
                }
                throw error;
              }
              return started;
            }),
          startProcess: (handle: SandboxHandle, command: string, o?) => {
            return useHandle(handle, (sandbox, handle) =>
              requireCap(sandbox, "startProcess", handle.scopeId).startProcess(handle, command, o),
            );
          },
          readProcess: (handle: SandboxHandle, id: string, o?) =>
            useHandle(handle, (sandbox, handle) =>
              requireCap(sandbox, "readProcess", handle.scopeId).readProcess(handle, id, o),
            ),
          writeStdin: (handle: SandboxHandle, id: string, data: string) =>
            useHandle(handle, (sandbox, handle) =>
              requireCap(sandbox, "writeStdin", handle.scopeId).writeStdin(handle, id, data),
            ),
          signalProcess: (handle: SandboxHandle, id: string, sig: string) =>
            useHandle(handle, (sandbox, handle) =>
              requireCap(sandbox, "signalProcess", handle.scopeId).signalProcess(handle, id, sig),
            ),
          listProcesses: (handle: SandboxHandle) =>
            useHandle(handle, (sandbox, handle) =>
              requireCap(sandbox, "listProcesses", handle.scopeId).listProcesses(handle),
            ),
        }
      : {}),
    ...(some((s) => typeof s.exportFiles === "function")
      ? {
          exportFiles: (handle: SandboxHandle, o?) =>
            useHandle(handle, (sandbox, handle) =>
              requireCap(sandbox, "exportFiles", handle.scopeId).exportFiles(handle, o),
            ),
        }
      : {}),
    ...(some((s) => typeof s.computerStatus === "function")
      ? {
          computerStatus: async (scopeId: string) => {
            const target = await computerTarget(scopeId);
            const action = () => requireCap(target.sandbox, "computerStatus", scopeId).computerStatus(target.scopeId);
            return target.resourceId && opts.resources ? opts.resources.use(target.resourceId, action) : action();
          },
        }
      : {}),
    ...(some((s) => typeof s.restartComputer === "function")
      ? {
          restartComputer: async (scopeId: string) => {
            const target = await computerTarget(scopeId);
            const action = () => requireCap(target.sandbox, "restartComputer", scopeId).restartComputer(target.scopeId);
            return target.resourceId && opts.resources ? opts.resources.use(target.resourceId, action, true) : action();
          },
        }
      : {}),
    ...(some(supportsBlobStaging)
      ? {
          stageIn: (handle: SandboxHandle, dest: string, blobId: string, opts?: StageOptions) =>
            useHandle(handle, (sandbox, handle) =>
              requireCap(sandbox, "stageIn", handle.scopeId).stageIn(handle, dest, blobId, opts),
            ),
          stageOut: (handle: SandboxHandle, src: string, opts?: StageOptions) =>
            useHandle(handle, (sandbox, handle) =>
              requireCap(sandbox, "stageOut", handle.scopeId).stageOut(handle, src, opts),
            ),
          importFiles: (handle: SandboxHandle, entries) =>
            useHandle(handle, (sandbox, handle) =>
              requireCap(sandbox, "importFiles", handle.scopeId).importFiles(handle, entries),
            ),
        }
      : {}),

    ...(some((s) => !!s.reapDeepIdle)
      ? {
          async reapDeepIdle(idleMs: number, devIdleMs?: number) {
            let reaped = 0;
            for (const s of Object.values(backends)) {
              if (s?.reapDeepIdle) reaped += (await s.reapDeepIdle(idleMs, devIdleMs).catch(swallowReap)).reaped ?? 0;
            }
            return { reaped };
          },
        }
      : {}),
  };

  return router;
}

const writableScope = (layers: WorkspaceLayer[]): string =>
  (layers.find((l) => l.mode === "rw") ?? layers[0])?.scopeId ?? "default";

const swallowReap = swallowAs("sandbox-router: reapDeepIdle on a backend", { reaped: 0 });

const constructed = (backends: Partial<Record<SandboxBackendName, Sandbox>>): Sandbox[] =>
  Object.values(backends).filter((s): s is Sandbox => !!s);
