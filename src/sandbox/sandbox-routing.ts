import type { SandboxResource, SandboxResources } from "./sandbox-resources.ts";
import { takeLoadSample, withLoadProbe, type LoadSample } from "./load-probe.ts";
import { bootTenant, tenancyBooted } from "../tenants/boot.ts";
import { boundTenant } from "../tenants/context.ts";
import type { ScopeId } from "../types.ts";
import { swallow, swallowAs } from "../util/errors.ts";
import {
  CapabilityUnsupportedError,
  removeDirAndList,
  SandboxProvisionCleanupError,
  supportsBlobStaging,
  supportsProcessSessions,
  type AgentComputerProfile,
  type AgentComputerSpec,
  type ExecOptions,
  type ExecResult,
  type ProvisionOptions,
  type Sandbox,
  type SandboxHandle,
  type StageOptions,
  type TeardownOptions,
} from "./sandbox.ts";

const PRESSURE_RECORD_FULL60 = 75;
const PRESSURE_CLEAR_FULL60 = 40;
const LOAD_WRITE_INTERVAL_MS = 10_000;

const createdSize = (
  sample: LoadSample,
  record: Pick<SandboxResource, "memoryGb" | "spec">,
  live: AgentComputerSpec | undefined,
): LoadSample => ({
  ...sample,
  memTotalMb:
    (record.memoryGb ? record.memoryGb * 1024 : (record.spec?.memoryMb ?? live?.memoryMb)) || sample.memTotalMb,
  diskTotalGb: record.spec?.diskGb || live?.diskGb || sample.diskTotalGb,
});

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
  | "do-managed-agents"
  | "render";

export class NoDefaultSandboxError extends Error {
  constructor() {
    super(
      "this scope has no default sandbox; get one as the sandbox tool describes, then retry before reporting blocked",
    );
  }
}

export interface RoutingSandboxOptions {
  backends: Partial<Record<SandboxBackendName, Sandbox>>;
  defaultBackend: SandboxBackendName;
  resources: SandboxResources;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

const TENANT_SEPARATED: ReadonlySet<SandboxBackendName> = new Set(["sprites", "modal", "superserve"]);

function requireTenantSeparation(name: SandboxBackendName): void {
  if (TENANT_SEPARATED.has(name) || !tenancyBooted()) return;
  const tenant = boundTenant();
  const boot = bootTenant();
  if (boot !== undefined && (tenant === undefined || tenant === boot)) return;
  throw new Error(`sandbox backend ${name} does not keep tenants apart; only a single-tenant deployment can use it`);
}

export function createSandboxRouter(opts: RoutingSandboxOptions): Sandbox {
  const { backends, resources, defaultBackend } = opts;
  const fallback = ((): Sandbox => {
    const s = backends[defaultBackend];
    if (!s) throw new Error(`sandbox router: default backend ${defaultBackend} is not constructed`);
    return s;
  })();

  const backendFor = (name: SandboxBackendName): Sandbox => {
    requireTenantSeparation(name);
    const sandbox = backends[name];
    if (!sandbox) throw new Error(`sandbox backend unavailable: ${name}; refusing to use a substitute computer`);
    return sandbox;
  };

  const forHandle = (handle: SandboxHandle): Sandbox => {
    requireTenantSeparation((handle.backend ?? defaultBackend) as SandboxBackendName);
    if (!handle.backend) return fallback;
    const sandbox = backends[handle.backend as SandboxBackendName];
    if (!sandbox) throw new Error(`sandbox backend unavailable: ${handle.backend}`);
    return sandbox;
  };

  const useHandle = <T>(handle: SandboxHandle, action: () => Promise<T>): Promise<T> =>
    handle.resourceId ? resources.use(handle.resourceId, action) : action();

  const resourceFor = (scopeId: string, sandboxId: string | undefined) =>
    sandboxId !== undefined ? resources.get(sandboxId) : resources.resolve(scopeId);

  async function computerTarget(scopeId: string, sandboxId?: string) {
    const resource = await resourceFor(scopeId, sandboxId);
    if (!resource) throw new NoDefaultSandboxError();
    return {
      sandbox: backendFor(resource.backend),
      scopeId: resource.backingScopeId,
      resourceId: resource.id,
      memoryGb: resource.memoryGb,
    };
  }

  const pressureEpisodes = new Set<string>();
  const loadWrites = new Map<string, number>();
  const notePressure = (resourceId: string, handle: SandboxHandle, sample: LoadSample): void => {
    const io = sample.ioFull60;
    if (io !== null && io >= PRESSURE_RECORD_FULL60 && !pressureEpisodes.has(resourceId)) {
      pressureEpisodes.add(resourceId);
      opts.onError?.({
        category: "agent_computer",
        code: "io_pressure_high",
        message: `sandbox ${resourceId} (${handle.backend ?? defaultBackend}): io pressure full avg60=${io}% (load ${sample.load1}) — disk-bound work is stalling`,
        ...(handle.scopeId ? { scopeLabel: handle.scopeId } : {}),
      });
    } else if (io === null || io < PRESSURE_CLEAR_FULL60) {
      pressureEpisodes.delete(resourceId);
    }
  };

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
      const resource = await resourceFor(scopeId, sandboxId);
      return resource ? backendFor(resource.backend).profile : fallback.profile;
    },

    async provision(scope: ScopeId, provOpts?: ProvisionOptions): Promise<SandboxHandle> {
      const resource = await resourceFor(scope, provOpts?.sandboxId);
      const backend = resource?.backend ?? (provOpts?.scratch ? await resources.defaultBackend() : defaultBackend);
      const sandbox = backendFor(backend);
      const provision = async (target: ScopeId, options = provOpts) => {
        try {
          return await sandbox.provision(target, options);
        } catch (error) {
          if (error instanceof SandboxProvisionCleanupError) error.handle.backend = backend;
          throw error;
        }
      };
      if (provOpts?.scratch) {
        const handle = await provision(scope);
        return { ...handle, backend, scopeId: scope };
      }
      if (!resource) throw new NoDefaultSandboxError();
      const sized = resource.memoryGb ? { ...provOpts, memoryGb: resource.memoryGb } : provOpts;
      const handle = await resources.use(resource.id, () => provision(resource.backingScopeId, sized));
      return { ...handle, backend: resource.backend, scopeId: resource.ownerScopeId, resourceId: resource.id };
    },

    async run(handle, command, execOpts?: ExecOptions): Promise<ExecResult> {
      const resourceId = handle.resourceId;
      if (!resourceId) return forHandle(handle).run(handle, command, execOpts);
      const result = await resources.use(resourceId, () =>
        forHandle(handle).run(handle, withLoadProbe(command), execOpts),
      );
      const { stdout, sample } = takeLoadSample(result.stdout, Date.now());
      if (!sample) return { ...result, stdout };
      notePressure(resourceId, handle, sample);
      if (sample.sampledAt - (loadWrites.get(resourceId) ?? 0) >= LOAD_WRITE_INTERVAL_MS) {
        loadWrites.set(resourceId, sample.sampledAt);
        await resources
          .get(resourceId)
          .then((record) =>
            resources.recordLoad(resourceId, createdSize(sample, record, forHandle(handle).profile.spec)),
          )
          .catch(swallowAs("sandbox router: record load sample", undefined));
      }
      return { ...result, stdout, load: sample };
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
      return useHandle(handle, () => removeDirAndList(forHandle(handle), handle, removeRelDir, listRelDir));
    },
    teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      const resourceId = handle.resourceId;
      if (!resourceId) return forHandle(handle).teardown(handle, tdOpts);
      if (tdOpts?.destroy) {
        pressureEpisodes.delete(resourceId);
        loadWrites.delete(resourceId);
      }
      const parks = !tdOpts?.destroy && !tdOpts?.keepWarm && !!forHandle(handle).profile.parksOnTeardown;
      return resources.use(
        resourceId,
        async () => {
          const held = parks && !!(await resources.get(resourceId)).holders?.length;
          return forHandle(handle).teardown(handle, held ? { ...tdOpts, keepWarm: true } : tdOpts);
        },
        !!tdOpts?.destroy || parks,
      );
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
          computerStatus: async (scopeId: string, sandboxId?: string) => {
            const target = await computerTarget(scopeId, sandboxId);
            const action = () => requireCap(target.sandbox, "computerStatus", scopeId).computerStatus(target.scopeId);
            return resources.use(target.resourceId, action);
          },
        }
      : {}),
    ...(some((s) => typeof s.restartComputer === "function")
      ? {
          restartComputer: async (scopeId: string, _memoryGb?: number, sandboxId?: string) => {
            const target = await computerTarget(scopeId, sandboxId);
            const action = () =>
              requireCap(target.sandbox, "restartComputer", scopeId).restartComputer(target.scopeId, target.memoryGb);
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

const swallowReap = swallowAs("sandbox-router: reapDeepIdle on a backend", { reaped: 0 });

const constructed = (backends: Partial<Record<SandboxBackendName, Sandbox>>): Sandbox[] =>
  Object.values(backends).filter((s): s is Sandbox => !!s);
