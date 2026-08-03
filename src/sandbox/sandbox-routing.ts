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
  type TeardownOptions,
} from "./sandbox.ts";

export type SandboxBackendName = "sprites" | "aws" | "local" | "smolmachines";

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
      message: `scope routed to ${name} but that backend is not constructed here; using ${defaultBackend}`,
      scopeLabel: scopeId,
    });
    return { name: defaultBackend, sandbox: fallback };
  }

  const forHandle = (handle: SandboxHandle): Sandbox =>
    (handle.backend && backends[handle.backend as SandboxBackendName]) || fallback;

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
      return (await pick(scopeId)).sandbox.profile;
    },

    async provision(layers: WorkspaceLayer[], provOpts?: ProvisionOptions): Promise<SandboxHandle> {
      const scope = provOpts?.routeScopeId ?? writableScope(layers);
      const { name, sandbox } = await pick(scope);
      const handle = await sandbox.provision(layers, provOpts);
      return { ...handle, backend: name, ...(scope ? { scopeId: scope } : {}) };
    },

    run(handle, command, execOpts?: ExecOptions): Promise<ExecResult> {
      return forHandle(handle).run(handle, command, execOpts);
    },
    readFile(handle, relPath) {
      return forHandle(handle).readFile(handle, relPath);
    },
    writeFile(handle, relPath, data) {
      return forHandle(handle).writeFile(handle, relPath, data);
    },
    writeFileBytes(handle, relPath, data) {
      return forHandle(handle).writeFileBytes(handle, relPath, data);
    },
    readFileBytes(handle, relPath) {
      return forHandle(handle).readFileBytes(handle, relPath);
    },
    listDir(handle, relDir) {
      return forHandle(handle).listDir(handle, relDir);
    },
    removeDir(handle, relDir) {
      return forHandle(handle).removeDir(handle, relDir);
    },
    teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      return forHandle(handle).teardown(handle, tdOpts);
    },

    ...(some(supportsProcessSessions)
      ? {
          startProcess: (handle: SandboxHandle, command: string, o?) =>
            requireCap(forHandle(handle), "startProcess", handle.scopeId).startProcess(handle, command, o),
          readProcess: (handle: SandboxHandle, id: string, o?) =>
            requireCap(forHandle(handle), "readProcess", handle.scopeId).readProcess(handle, id, o),
          writeStdin: (handle: SandboxHandle, id: string, data: string) =>
            requireCap(forHandle(handle), "writeStdin", handle.scopeId).writeStdin(handle, id, data),
          signalProcess: (handle: SandboxHandle, id: string, sig: string) =>
            requireCap(forHandle(handle), "signalProcess", handle.scopeId).signalProcess(handle, id, sig),
          listProcesses: (handle: SandboxHandle) =>
            requireCap(forHandle(handle), "listProcesses", handle.scopeId).listProcesses(handle),
        }
      : {}),
    ...(some((s) => typeof s.backupComputer === "function")
      ? {
          backupComputer: (handle: SandboxHandle, o?) =>
            requireCap(forHandle(handle), "backupComputer", handle.scopeId).backupComputer(handle, o),
        }
      : {}),
    ...(some(supportsBlobStaging)
      ? {
          stageIn: (handle: SandboxHandle, dest: string, blobId: string) =>
            requireCap(forHandle(handle), "stageIn", handle.scopeId).stageIn(handle, dest, blobId),
          stageOut: (handle: SandboxHandle, src: string) =>
            requireCap(forHandle(handle), "stageOut", handle.scopeId).stageOut(handle, src),
          extractFiles: (handle: SandboxHandle, entries) =>
            requireCap(forHandle(handle), "extractFiles", handle.scopeId).extractFiles(handle, entries),
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
