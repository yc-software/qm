import type { SandboxResources } from "./sandbox-resources.ts";
import type { WorkspaceLayer } from "../types.ts";
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
  type StageOptions,
  type TeardownOptions,
} from "./sandbox.ts";

export type SandboxBackendName = "sprites" | "aws" | "local" | "smolmachines" | "e2b" | "modal" | "porter" | "agent37";

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
  routes: DurableMap<SandboxRoute>;
  defaultBackend: SandboxBackendName;
  resources?: SandboxResources;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
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
    const name = route?.backend ?? defaultBackend;
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

  const forHandle = (handle: SandboxHandle): Sandbox => {
    if (!handle.backend) return fallback;
    const sandbox = backends[handle.backend as SandboxBackendName];
    if (!sandbox) throw new Error(`sandbox backend unavailable: ${handle.backend}`);
    return sandbox;
  };

  const useHandle = <T>(handle: SandboxHandle, action: () => Promise<T>): Promise<T> =>
    handle.resourceId && opts.resources ? opts.resources.use(handle.resourceId, action) : action();

  async function computerTarget(scopeId: string): Promise<{ sandbox: Sandbox; scopeId: string; resourceId?: string }> {
    const resource = await opts.resources?.resolve(scopeId);
    if (resource === null) throw new Error("this scope has no default sandbox");
    if (resource) {
      const sandbox = backends[resource.backend];
      if (!sandbox) throw new Error(`sandbox backend unavailable: ${resource.backend}`);
      return { sandbox, scopeId: resource.backingScopeId, resourceId: resource.id };
    }
    return { sandbox: await pickStrict(scopeId), scopeId };
  }

  async function pickStrict(scopeId: string): Promise<Sandbox> {
    const route = await routeFor(scopeId);
    const name = route?.backend ?? defaultBackend;
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
  const some = (pred: (s: Sandbox) => boolean): boolean => constructed(backends).some(pred);

  const router: Sandbox = {
    profile: fallback.profile,

    async profileFor(scopeId: string): Promise<AgentComputerProfile> {
      const resource = await opts.resources?.resolve(scopeId);
      if (resource) {
        const sandbox = backends[resource.backend];
        if (!sandbox) throw new Error(`sandbox backend unavailable: ${resource.backend}`);
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
        const sandbox = backends[resource.backend];
        if (!sandbox) throw new Error(`sandbox backend unavailable: ${resource.backend}`);
        const routedLayers = layers.map((layer) =>
          layer.mode === "rw" ? { ...layer, scopeId: resource.backingScopeId } : layer,
        );
        const handle = await opts.resources!.use(resource.id, () => sandbox.provision(routedLayers, provOpts));
        return { ...handle, backend: resource.backend, scopeId: resource.ownerScopeId, resourceId: resource.id };
      }
      const { name, sandbox } = await pick(scope);
      const handle = await sandbox.provision(layers, provOpts);
      const resourceId =
        !provOpts?.scratch && scope ? await opts.resources?.recordLegacy(scope, name, handle) : undefined;
      return { ...handle, backend: name, ...(scope ? { scopeId: scope } : {}), ...(resourceId ? { resourceId } : {}) };
    },

    run(handle, command, execOpts?: ExecOptions): Promise<ExecResult> {
      const run = () => forHandle(handle).run(handle, command, execOpts);
      return useHandle(handle, run);
    },
    readFile(handle, relPath) {
      return useHandle(handle, () => forHandle(handle).readFile(handle, relPath));
    },
    writeFile(handle, relPath, data) {
      const write = () => forHandle(handle).writeFile(handle, relPath, data);
      return useHandle(handle, write);
    },
    writeFileBytes(handle, relPath, data) {
      const write = () => forHandle(handle).writeFileBytes(handle, relPath, data);
      return useHandle(handle, write);
    },
    readFileBytes(handle, relPath) {
      return useHandle(handle, () => forHandle(handle).readFileBytes(handle, relPath));
    },
    listDir(handle, relDir) {
      return useHandle(handle, () => forHandle(handle).listDir(handle, relDir));
    },
    removeDir(handle, relDir) {
      const remove = () => forHandle(handle).removeDir(handle, relDir);
      return useHandle(handle, remove);
    },
    teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      return useHandle(handle, () => forHandle(handle).teardown(handle, tdOpts));
    },

    ...(some(supportsProcessSessions)
      ? {
          startRegisteredProcess: (handle: SandboxHandle, command: string, register, o?) =>
            useHandle(handle, async () => {
              const sandbox = requireCap(forHandle(handle), "startProcess", handle.scopeId);
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
            const start = () =>
              requireCap(forHandle(handle), "startProcess", handle.scopeId).startProcess(handle, command, o);
            return useHandle(handle, start);
          },
          readProcess: (handle: SandboxHandle, id: string, o?) =>
            useHandle(handle, () =>
              requireCap(forHandle(handle), "readProcess", handle.scopeId).readProcess(handle, id, o),
            ),
          writeStdin: (handle: SandboxHandle, id: string, data: string) =>
            useHandle(handle, () =>
              requireCap(forHandle(handle), "writeStdin", handle.scopeId).writeStdin(handle, id, data),
            ),
          signalProcess: (handle: SandboxHandle, id: string, sig: string) =>
            useHandle(handle, () =>
              requireCap(forHandle(handle), "signalProcess", handle.scopeId).signalProcess(handle, id, sig),
            ),
          listProcesses: (handle: SandboxHandle) =>
            useHandle(handle, () =>
              requireCap(forHandle(handle), "listProcesses", handle.scopeId).listProcesses(handle),
            ),
        }
      : {}),
    ...(some((s) => typeof s.exportFiles === "function")
      ? {
          exportFiles: (handle: SandboxHandle, o?) =>
            useHandle(handle, () =>
              requireCap(forHandle(handle), "exportFiles", handle.scopeId).exportFiles(handle, o),
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
            return target.resourceId && opts.resources ? opts.resources.use(target.resourceId, action) : action();
          },
        }
      : {}),
    ...(some(supportsBlobStaging)
      ? {
          stageIn: (handle: SandboxHandle, dest: string, blobId: string, opts?: StageOptions) =>
            useHandle(handle, () =>
              requireCap(forHandle(handle), "stageIn", handle.scopeId).stageIn(handle, dest, blobId, opts),
            ),
          stageOut: (handle: SandboxHandle, src: string, opts?: StageOptions) =>
            useHandle(handle, () =>
              requireCap(forHandle(handle), "stageOut", handle.scopeId).stageOut(handle, src, opts),
            ),
          importFiles: (handle: SandboxHandle, entries) =>
            useHandle(handle, () =>
              requireCap(forHandle(handle), "importFiles", handle.scopeId).importFiles(handle, entries),
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
