import type { SandboxResources } from "./sandbox-resources.ts";
import type { WorkspaceLayer } from "../types.ts";
import { swallow, swallowAs } from "../util/errors.ts";
import {
  CapabilityUnsupportedError,
  SandboxProvisionCleanupError,
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

export type SandboxBackendName =
  | "sprites"
  | "aws"
  | "local"
  | "smolmachines"
  | "e2b"
  | "modal"
  | "porter"
  | "agent37"
  | "superserve"
  | "do-managed-agents";

export class NoDefaultSandboxError extends Error {
  constructor() {
    super(
      "this scope has no default sandbox; use sandbox list, create, set_default, then retry before reporting blocked",
    );
  }
}

export interface RoutingSandboxOptions {
  backends: Partial<Record<SandboxBackendName, Sandbox>>;
  defaultBackend: SandboxBackendName;
  resources: SandboxResources;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export function createSandboxRouter(opts: RoutingSandboxOptions): Sandbox {
  const { backends, resources, defaultBackend } = opts;
  const fallback = ((): Sandbox => {
    const s = backends[defaultBackend];
    if (!s) throw new Error(`sandbox router: default backend ${defaultBackend} is not constructed`);
    return s;
  })();

  const backendFor = (name: SandboxBackendName): Sandbox => {
    const sandbox = backends[name];
    if (!sandbox) throw new Error(`sandbox backend unavailable: ${name}; refusing to use a substitute computer`);
    return sandbox;
  };

  const forHandle = (handle: SandboxHandle): Sandbox => {
    if (!handle.backend) return fallback;
    const sandbox = backends[handle.backend as SandboxBackendName];
    if (!sandbox) throw new Error(`sandbox backend unavailable: ${handle.backend}`);
    return sandbox;
  };

  const useHandle = <T>(handle: SandboxHandle, action: () => Promise<T>): Promise<T> =>
    handle.resourceId ? resources.use(handle.resourceId, action) : action();

  async function computerTarget(scopeId: string) {
    const resource = await resources.resolve(scopeId);
    if (!resource) throw new NoDefaultSandboxError();
    return { sandbox: backendFor(resource.backend), scopeId: resource.backingScopeId, resourceId: resource.id };
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

    async profileFor(scopeId: string, sandboxId?: string): Promise<AgentComputerProfile> {
      const resource = sandboxId ? await resources.get(sandboxId) : await resources.resolve(scopeId);
      return resource ? backendFor(resource.backend).profile : fallback.profile;
    },

    async provision(layers: WorkspaceLayer[], provOpts?: ProvisionOptions): Promise<SandboxHandle> {
      const scope = provOpts?.routeScopeId ?? writableScope(layers);
      const resource = provOpts?.sandboxId ? await resources.get(provOpts.sandboxId) : await resources.resolve(scope);
      const backend = resource?.backend ?? defaultBackend;
      const sandbox = backendFor(backend);
      const provision = async (targetLayers: WorkspaceLayer[]) => {
        try {
          return await sandbox.provision(targetLayers, provOpts);
        } catch (error) {
          if (error instanceof SandboxProvisionCleanupError) error.handle.backend = backend;
          throw error;
        }
      };
      if (provOpts?.scratch) {
        const handle = await provision(layers);
        return { ...handle, backend, scopeId: scope };
      }
      if (!resource) throw new NoDefaultSandboxError();
      const routedLayers = layers.map((layer) =>
        layer.mode === "rw" ? { ...layer, scopeId: resource.backingScopeId } : layer,
      );
      const handle = await resources.use(resource.id, () => provision(routedLayers));
      return { ...handle, backend: resource.backend, scopeId: resource.ownerScopeId, resourceId: resource.id };
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
    removeDirAndList(handle, removeRelDir, listRelDir) {
      return useHandle(handle, async () => {
        const sandbox = forHandle(handle);
        if (sandbox.removeDirAndList) return sandbox.removeDirAndList(handle, removeRelDir, listRelDir);
        await sandbox.removeDir(handle, removeRelDir);
        return sandbox.listDir(handle, listRelDir);
      });
    },
    teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      const action = () => forHandle(handle).teardown(handle, tdOpts);
      return handle.resourceId
        ? resources.use(handle.resourceId, action, !!tdOpts?.destroy || !!forHandle(handle).profile.parksOnTeardown)
        : action();
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
            return resources.use(target.resourceId, action);
          },
        }
      : {}),
    ...(some((s) => typeof s.restartComputer === "function")
      ? {
          restartComputer: async (scopeId: string) => {
            const target = await computerTarget(scopeId);
            const action = () => requireCap(target.sandbox, "restartComputer", scopeId).restartComputer(target.scopeId);
            return resources.use(target.resourceId, action, true);
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
