import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { swallowAs } from "../util/errors.ts";
import {
  E2bCommandLostError,
  E2bSandboxGoneError,
  runE2bScript,
  type E2bClient,
  type E2bSession,
} from "./e2b-client.ts";
import {
  createProviderSandbox,
  type MachineState,
  type ProviderSandbox,
  type SandboxShared,
  type StoredSandboxRecord,
} from "./provider-sandbox.ts";
import type { Sandbox } from "./sandbox.ts";

const HOME_DIR = "/home/user";
const DEFAULT_KEEP_WARM_SEC = 3600;

export const E2B_TEMPLATE_TOOLS = ["wget", "unzip", "gh", "aws", "x-api"];

export interface StoredE2bSandbox extends StoredSandboxRecord {
  sandboxId?: string;
}

export interface E2bSandboxOptions extends SandboxShared {
  client: E2bClient;
  store: DurableMap<StoredE2bSandbox>;
}

export function createE2bSandbox(workspace: WorkspaceStore, opts: E2bSandboxOptions): Sandbox {
  const { client, store } = opts;
  const keepWarmMs = (opts.keepWarmSec ?? DEFAULT_KEEP_WARM_SEC) * 1000;
  const sessions = new Map<string, E2bSession>();
  const scratchNames = new Set<string>();
  const restoredFrom = new Map<string, string>();
  const reviving = new Map<string, Promise<E2bSession>>();
  const observed: { cpus?: number; memoryMb?: number; diskGb?: number } = {};

  async function adopt(name: string, session: E2bSession): Promise<E2bSession> {
    sessions.set(name, session);
    const info = await client.info?.(session.sandboxId).catch(swallowAs("e2b-sandbox: info", undefined));
    if (info?.cpuCount) observed.cpus = info.cpuCount;
    if (info?.memoryMb) observed.memoryMb = info.memoryMb;
    return session;
  }

  async function locate(name: string): Promise<{ sandboxId: string; state: string } | null> {
    const listed = await client.list({ name });
    return listed.find((s) => s.state === "running") ?? listed[0] ?? null;
  }

  async function launch(name: string, scratch: boolean, fromSnapshot?: string): Promise<E2bSession> {
    const session = await client.create({
      metadata: { name, ...(scratch ? { scratch: "true" } : {}) },
      autoPause: !scratch,
      ...(fromSnapshot ? { fromSnapshot } : {}),
    });
    if (scratch) scratchNames.add(name);
    return adopt(name, session);
  }

  async function createResident(name: string, scope: string): Promise<E2bSession> {
    const stored = await store.get(scope);
    const checkpointId = stored?.checkpointId;
    if (stored?.homeDirty && !checkpointId)
      throw new Error("e2b sandbox is gone; explicitly import a recovery snapshot before replacing its home");
    const session = await launch(name, false, checkpointId);
    if (checkpointId) restoredFrom.set(name, checkpointId);
    await store.merge(scope, { sandboxId: session.sandboxId });
    return session;
  }

  async function connect(name: string): Promise<E2bSession> {
    const cached = sessions.get(name);
    if (cached) return cached;
    const found = await locate(name);
    if (!found) throw new Error(`e2b sandbox ${name} is not provisioned`);
    return adopt(name, await client.connect(found.sandboxId));
  }

  async function replace(name: string): Promise<E2bSession> {
    if (scratchNames.has(name)) return launch(name, true);
    const found = await locate(name);
    if (found) return adopt(name, await client.connect(found.sandboxId));
    const scope = sandbox.scopeFor(name);
    if (!scope) throw new Error(`e2b sandbox ${name} is not provisioned`);
    return createResident(name, scope);
  }

  function revive(name: string): Promise<E2bSession> {
    const pending = reviving.get(name) ?? replace(name).finally(() => reviving.delete(name));
    reviving.set(name, pending);
    return pending;
  }

  async function withSession<T>(name: string, action: (session: E2bSession) => Promise<T>): Promise<T> {
    try {
      return await action(await connect(name));
    } catch (err) {
      if (err instanceof E2bCommandLostError) sessions.delete(name);
      if (!(err instanceof E2bSandboxGoneError)) throw err;
      sessions.delete(name);
      return action(await revive(name));
    }
  }

  async function destroy(name: string): Promise<void> {
    const ids = new Set([sessions.get(name)?.sandboxId, ...(await client.list({ name })).map((s) => s.sandboxId)]);
    for (const id of ids) if (id) await client.kill(id);
    sessions.delete(name);
    restoredFrom.delete(name);
  }

  async function inspect(name: string): Promise<MachineState | null> {
    const found = await locate(name);
    if (!found) return null;
    const running = found.state === "running";
    const session = sessions.get(name);
    const metrics = running && session ? await session.metrics().catch(swallowAs("e2b-sandbox: metrics", null)) : null;
    if (metrics?.diskTotalBytes) observed.diskGb = Math.round(metrics.diskTotalBytes / 2 ** 30);
    return {
      state: running ? "running" : "parked",
      detail: `e2b sandbox ${found.sandboxId} ${found.state}`,
      ...(metrics
        ? {
            resources: {
              cpuUsedPct: metrics.cpuUsedPct,
              memUsedMb: Math.round(metrics.memUsedBytes / 2 ** 20),
              memTotalMb: Math.round(metrics.memTotalBytes / 2 ** 20),
              diskUsedGb: Math.round((metrics.diskUsedBytes / 2 ** 30) * 10) / 10,
              diskTotalGb: Math.round((metrics.diskTotalBytes / 2 ** 30) * 10) / 10,
            },
          }
        : {}),
    };
  }

  const sandbox: ProviderSandbox = createProviderSandbox(
    workspace,
    {
      backend: "e2b",
      homeDir: HOME_DIR,
      os: "Linux — E2B Firecracker sandbox (provider pause preserves state; publish durable work to git or Files)",
      writablePersistence: "provider_managed",
      egressEnforcement: opts.egressProxyUrl ? "domain" : "none",
      exec: (name, script, timeoutSec) => withSession(name, (s) => runE2bScript(s, script, timeoutSec)),
      writeAbsBytes: (name, absPath, data) => withSession(name, (s) => s.writeFileBytes(absPath, data)),
      readAbsBytes: (name, absPath) => withSession(name, (s) => s.readFileBytes(absPath)),
      inspect,
      async create(name, { scratch, scope }) {
        if (scratch || !scope) await launch(name, scratch);
        else await createResident(name, scope);
      },
      async resume(name) {
        sessions.delete(name);
        await connect(name);
      },
      async park(name, { keepWarm }) {
        const session = sessions.get(name);
        if (!session) return;
        if (keepWarm) return session.keepAlive(keepWarmMs);
        await session.pause();
        sessions.delete(name);
      },
      destroy,
      isLive: (name) => sessions.has(name),
      forget(name) {
        sessions.delete(name);
        scratchNames.delete(name);
        restoredFrom.delete(name);
      },
      async restart(name) {
        const session = await connect(name);
        await session.pause({ keepMemory: false });
        sessions.delete(name);
        await adopt(name, await client.connect(session.sandboxId));
      },
      checkpoints: {
        capture: async (name) => (await (await connect(name)).createSnapshot()).snapshotId,
        async restore(name, checkpointId) {
          const fresh = restoredFrom.get(name) === checkpointId;
          restoredFrom.delete(name);
          if (fresh) return;
          await destroy(name);
          await launch(name, false, checkpointId);
        },
        drop: (_name, checkpointId) => client.deleteSnapshot(checkpointId),
      },
    },
    opts,
    opts.store,
  );
  Object.defineProperties(sandbox.profile.spec!, {
    cpus: { get: () => observed.cpus, enumerable: true },
    memoryMb: { get: () => observed.memoryMb, enumerable: true },
    diskGb: { get: () => observed.diskGb, enumerable: true },
  });
  return sandbox;
}
