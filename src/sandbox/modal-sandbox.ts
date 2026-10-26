import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { orgId as configOrgId } from "../config.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { createExecProcessSessions } from "./exec-process-session.ts";
import { sandboxScopeName } from "./exec-sandbox-base.ts";
import {
  MODAL_CHECKPOINT_RETENTION_MS,
  ModalNameConflictError,
  ModalSandboxGoneError,
  type ModalClient,
  type ModalSession,
} from "./modal-client.ts";
import {
  createProviderSandbox,
  type ProviderSandbox,
  type SandboxShared,
  type StoredSandboxRecord,
} from "./provider-sandbox.ts";
import type { ComputerStatus, ExecResult, Sandbox, SandboxHandle, TeardownOptions } from "./sandbox.ts";

const HOME_DIR = "/root";
const ROTATE_MARGIN_MS = 4 * 3600_000;
const RETIRE_MARGIN_MS = 30 * 60_000;
const ROTATION_HOLD_MS = 10 * 60_000;
const RENEW_MARGIN_MS = 7 * 24 * 3600_000;
const ORPHAN_GRACE_MS = 10 * 60_000;
const ACTIVITY_TOUCH_INTERVAL_MS = 10 * 60_000;
const DEFAULT_IDLE_REAP_MS = 6 * 3600_000;
const DEFAULT_SNAPSHOT_INTERVAL_SEC = 300;
const LEGACY_KEYS = [
  "hydrationPending",
  "nativeSnapshotId",
  "nativeSnapshotExpiresAtMs",
  "recoveryError",
  "snapshotGeneration",
  "lastSnapshotAttemptMs",
];

export interface StoredModalSandbox extends StoredSandboxRecord {
  sandboxId?: string;
  createdAtMs?: number;
  expiresAtMs?: number;
  lastActivityMs?: number;
  orgId?: string;
}

export interface ModalSandboxOptions extends SandboxShared {
  client: ModalClient;
  store: DurableMap<StoredModalSandbox>;
}

function upgradeLegacy(rec: StoredModalSandbox): StoredModalSandbox | null {
  const legacy = rec as StoredModalSandbox & Record<string, unknown>;
  if (!LEGACY_KEYS.some((key) => key in legacy)) return null;
  const kept = Object.fromEntries(Object.entries(legacy).filter(([key]) => !LEGACY_KEYS.includes(key)));
  const checkpointId = legacy.nativeSnapshotId as string | undefined;
  const expiresAtMs = legacy.nativeSnapshotExpiresAtMs as number | undefined;
  return {
    ...kept,
    ...(legacy.hydrationPending ? { initializationPending: true } : {}),
    ...(checkpointId
      ? {
          checkpointId,
          checkpointAtMs: expiresAtMs ? expiresAtMs - MODAL_CHECKPOINT_RETENTION_MS : legacy.lastSnapshotMs,
        }
      : {}),
    ...(legacy.recoveryError ? { snapshotError: legacy.recoveryError as string } : {}),
  };
}

function upgradedStore(store: DurableMap<StoredModalSandbox>): DurableMap<StoredModalSandbox> {
  let ready: Promise<void> | null = null;
  const upgrade = async (): Promise<void> => {
    for (const [scope, rec] of await store.entries()) {
      if (!upgradeLegacy(rec)) continue;
      if (store.update) await store.update(scope, (current) => upgradeLegacy(current) ?? current);
      else await store.put(scope, upgradeLegacy(rec)!);
    }
  };
  const wait = (): Promise<void> =>
    (ready ??= upgrade().catch((e: unknown) => {
      ready = null;
      throw e;
    }));
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        await wait();
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

export function createModalSandbox(workspace: WorkspaceStore, opts: ModalSandboxOptions): Sandbox {
  const { client } = opts;
  const store = upgradedStore(opts.store);
  const prefix = opts.namePrefix ?? "qm";
  const nameFor = (scope: string): string => sandboxScopeName(prefix, scope);
  const snapshotIntervalMs = (opts.snapshotIntervalSec ?? DEFAULT_SNAPSHOT_INTERVAL_SEC) * 1000;
  const lock = opts.advisoryLock;
  const sessions = new Map<string, ModalSession>();
  const scratchNames = new Set<string>();
  const scopeByName = new Map<string, string>();
  const rotationHold = new Map<string, number>();
  const lastTouch = new Map<string, number>();
  const refreshAttempt = new Map<string, number>();
  const orphanFirstSeen = new Map<string, number>();
  const tags = (kind: "scope" | "scratch"): Record<string, string> => ({
    "qm-org": configOrgId(),
    "qm-prefix": prefix,
    "qm-kind": kind,
  });
  const report = (category: string, code: string, e: unknown, scopeLabel?: string): void => {
    opts.onError?.({ category, code, message: errMessage(e), ...(scopeLabel ? { scopeLabel } : {}) });
  };
  const sharedUse = <T>(scope: string, fn: () => Promise<T>): Promise<T> =>
    (lock.withSharedLock ?? lock.withLock)(`modal-use:${scope}`, fn);
  const exclusiveUse = <T>(scope: string, fn: () => Promise<T>): Promise<T> => lock.withLock(`modal-use:${scope}`, fn);

  const knownScope = (name: string): string | undefined => provider.scopeFor(name) ?? scopeByName.get(name);
  async function scopeOf(name: string): Promise<string | undefined> {
    const known = knownScope(name);
    if (known) return known;
    for (const [scope] of await store.entries()) scopeByName.set(nameFor(scope), scope);
    return scopeByName.get(name);
  }

  async function current(name: string): Promise<ModalSession> {
    const cached = sessions.get(name);
    if (cached) return cached;
    const found = scratchNames.has(name) ? null : await client.fromName(name);
    if (!found) throw new ModalSandboxGoneError(name, "no running sandbox holds this name");
    sessions.set(name, found);
    return found;
  }

  async function createScratch(name: string): Promise<ModalSession> {
    const session = await client.create({ tags: tags("scratch") });
    sessions.set(name, session);
    scratchNames.add(name);
    return session;
  }

  async function touch(scope: string): Promise<void> {
    const now = Date.now();
    if (now - (lastTouch.get(scope) ?? 0) < ACTIVITY_TOUCH_INTERVAL_MS) return;
    lastTouch.set(scope, now);
    await store.merge(scope, { lastActivityMs: now }).catch(swallowAs("modal-sandbox: record activity", undefined));
  }

  async function withSession<T>(name: string, action: (session: ModalSession) => Promise<T>): Promise<T> {
    if (scratchNames.has(name)) {
      try {
        return await action(await current(name));
      } catch (e) {
        if (!(e instanceof ModalSandboxGoneError)) throw e;
        return action(await createScratch(name));
      }
    }
    const scope = knownScope(name);
    if (!scope) throw new Error("sandbox handle has been released");
    await touch(scope);
    try {
      return await sharedUse(scope, async () => action(await current(name)));
    } catch (e) {
      if (!(e instanceof ModalSandboxGoneError)) throw e;
      sessions.delete(name);
      if ((await store.get(scope))?.initializationPending) throw e;
      await provider.ensureResident(scope);
      return sharedUse(scope, async () => action(await current(name)));
    }
  }

  async function exec(name: string, script: string, timeoutSec: number, env?: Record<string, string>) {
    return withSession(name, async (session): Promise<ExecResult> => {
      const r = await session.runCommand(script, { timeoutMs: timeoutSec * 1000, ...(env ? { env } : {}) });
      return { stdout: r.stdout, stderr: r.stderr, code: r.exitCode, timedOut: r.exitCode === 124 };
    });
  }

  async function destroy(name: string): Promise<void> {
    const cached = sessions.get(name);
    if (cached) await cached.terminate();
    if (!scratchNames.has(name)) {
      const ids = new Set<string>();
      const found = await client.fromName(name);
      if (found) ids.add(found.sandboxId);
      const scope = await scopeOf(name);
      const stored = scope ? (await store.get(scope))?.sandboxId : undefined;
      if (stored) ids.add(stored);
      if (cached) ids.delete(cached.sandboxId);
      for (const id of ids) await client.terminate(id);
    }
    sessions.delete(name);
    scratchNames.delete(name);
  }

  const provider: ProviderSandbox = createProviderSandbox(
    workspace,
    {
      backend: "modal",
      homeDir: HOME_DIR,
      os: "Debian 12 — Modal sandbox (24h max lifetime; home checkpoints have limited retention; publish durable work to git or Files)",
      ...(opts.cpus ? { cpus: opts.cpus } : {}),
      ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
      writablePersistence: "provider_managed",
      egressEnforcement: opts.egressProxyUrl ? "domain" : "none",
      envViaExec: true,
      exec,
      writeAbsBytes: (name, absPath, data) => withSession(name, (session) => session.writeFileBytes(absPath, data)),
      readAbsBytes: (name, absPath) => withSession(name, (session) => session.readFileBytes(absPath)),
      async inspect(name) {
        const found = await client.fromName(name);
        if (!found) {
          sessions.delete(name);
          return null;
        }
        sessions.set(name, found);
        return { state: "running", detail: `modal sandbox ${found.sandboxId}` };
      },
      async create(name, { scratch }) {
        if (scratch) {
          await createScratch(name);
          return;
        }
        let session: ModalSession;
        try {
          session = await client.create({ name, tags: tags("scope") });
        } catch (e) {
          const adopted = e instanceof ModalNameConflictError ? await client.fromName(name) : null;
          if (!adopted) throw e;
          session = adopted;
        }
        sessions.set(name, session);
        const scope = await scopeOf(name);
        const now = Date.now();
        if (scope)
          await store.merge(scope, {
            sandboxId: session.sandboxId,
            createdAtMs: now,
            expiresAtMs: now + client.lifetimeMs,
            orgId: configOrgId(),
          });
      },
      resume: async () => {},
      destroy,
      isLive: (name) => scratchNames.has(name) && sessions.has(name),
      async rotationDue(name) {
        const scope = await scopeOf(name);
        const expiresAtMs = scope ? (await store.get(scope))?.expiresAtMs : undefined;
        const now = Date.now();
        if (!expiresAtMs || expiresAtMs - now > ROTATE_MARGIN_MS || now < (rotationHold.get(name) ?? 0)) return false;
        rotationHold.set(name, now + ROTATION_HOLD_MS);
        return true;
      },
      checkpoints: {
        capture: async (name) => (await current(name)).snapshotHome(),
        async restore(name, checkpointId) {
          const scope = await scopeOf(name);
          const checkpointAtMs = scope ? (await store.get(scope))?.checkpointAtMs : undefined;
          if (checkpointAtMs && checkpointAtMs + MODAL_CHECKPOINT_RETENTION_MS <= Date.now())
            throw new Error(
              "Modal home checkpoint has expired; explicitly import a recovery snapshot before creating a replacement",
            );
          await (await current(name)).restoreHome(checkpointId);
        },
        drop: async () => {},
      },
    },
    opts,
    store,
  );

  const renewalDue = (rec: StoredModalSandbox, now: number): boolean => {
    if (!rec.checkpointId || !rec.checkpointAtMs) return false;
    const remaining = rec.checkpointAtMs + MODAL_CHECKPOINT_RETENTION_MS - now;
    return remaining > 0 && remaining <= RENEW_MARGIN_MS;
  };

  async function renew(scope: string, name: string, rec: StoredModalSandbox): Promise<void> {
    try {
      await provider.ensureResident(scope);
      await provider.lifecycle(scope, () => provider.captureCheckpoint(scope, name));
      await provider.lifecycle(scope, async () => {
        const after = await store.get(scope);
        if (after && !after.initializationPending && after.lastActivityMs === rec.lastActivityMs) await destroy(name);
      });
    } catch (e) {
      if (!(e instanceof ModalSandboxGoneError)) report("sandbox_snapshot", "checkpoint_renewal_failed", e, scope);
    }
  }

  function retire(scope: string, name: string, rec: StoredModalSandbox, idleCutoffMs?: number): Promise<number> {
    return provider.lifecycle(scope, () =>
      exclusiveUse(scope, async () => {
        const now = await store.get(scope);
        if (!now || now.initializationPending || now.sandboxId !== rec.sandboxId) return 0;
        if (idleCutoffMs !== undefined && (!now.lastActivityMs || now.lastActivityMs > idleCutoffMs)) return 0;
        try {
          await provider.captureCheckpoint(scope, name);
          await destroy(name);
          return 1;
        } catch (e) {
          if (e instanceof ModalSandboxGoneError) sessions.delete(name);
          else report("sandbox_reap", "deep_idle_reap_failed", e, scope);
          return 0;
        }
      }),
    );
  }

  async function forgetGone(scope: string, name: string, rec: StoredModalSandbox, now: number): Promise<void> {
    sessions.delete(name);
    if (rec.checkpointId) {
      if (renewalDue(rec, now)) await renew(scope, name, rec);
      return;
    }
    await provider.lifecycle(scope, async () => {
      const after = await store.get(scope);
      if (after && !after.checkpointId && !after.initializationPending && !(await client.fromName(name)))
        await store.delete(scope);
    });
  }

  async function busy(session: ModalSession, name: string): Promise<boolean> {
    const handle: SandboxHandle = { id: name, rootDir: `${HOME_DIR}/workspace`, homeDir: HOME_DIR, coldStart: false };
    const live = await createExecProcessSessions({
      run: async (_handle, command) => {
        const r = await session.runCommand(command, { timeoutMs: 60_000 });
        return { stdout: r.stdout, stderr: r.stderr, code: r.exitCode, timedOut: r.exitCode === 124 };
      },
    }).listProcesses(handle);
    return live.some((p) => p.status.state === "running");
  }

  async function refresh(scope: string, name: string, rec: StoredModalSandbox, now: number): Promise<void> {
    if (now - Math.max(rec.lastSnapshotMs ?? 0, refreshAttempt.get(scope) ?? 0) <= snapshotIntervalMs) return;
    refreshAttempt.set(scope, now);
    await provider
      .lifecycle(scope, async () => {
        const after = await store.get(scope);
        if (after && after.sandboxId === rec.sandboxId && !after.initializationPending)
          await provider.captureCheckpoint(scope, name);
      })
      .catch((e) => {
        if (!(e instanceof ModalSandboxGoneError)) report("sandbox_snapshot", "periodic_snapshot_failed", e, scope);
      });
  }

  async function sweepOrphans(now: number): Promise<number> {
    const listRunning = client.listRunning?.bind(client);
    if (!listRunning) return 0;
    const tracked = async (): Promise<Set<string>> => {
      const ids = new Set<string>();
      for (const [, rec] of await store.entries()) if (rec.sandboxId) ids.add(rec.sandboxId);
      for (const session of sessions.values()) ids.add(session.sandboxId);
      return ids;
    };
    let known = await tracked();
    const listed = new Set<string>();
    const candidates: string[] = [];
    try {
      for await (const sandboxId of listRunning(tags("scope"))) {
        listed.add(sandboxId);
        if (known.has(sandboxId)) continue;
        const firstSeen = orphanFirstSeen.get(sandboxId) ?? now;
        orphanFirstSeen.set(sandboxId, firstSeen);
        if (now - firstSeen >= ORPHAN_GRACE_MS) candidates.push(sandboxId);
      }
    } catch (e) {
      report("sandbox_reap", "orphan_list_failed", e);
      return 0;
    }
    for (const id of orphanFirstSeen.keys()) if (!listed.has(id) || known.has(id)) orphanFirstSeen.delete(id);
    if (!candidates.length) return 0;
    known = await tracked();
    let reaped = 0;
    for (const sandboxId of candidates) {
      if (known.has(sandboxId)) continue;
      try {
        await client.terminate(sandboxId);
        orphanFirstSeen.delete(sandboxId);
        reaped++;
      } catch (e) {
        report("sandbox_reap", "orphan_terminate_failed", e);
      }
    }
    return reaped;
  }

  return {
    ...provider,

    async teardown(handle: SandboxHandle, td?: TeardownOptions): Promise<void> {
      await provider.teardown(handle, td);
      const scope = handle.scratch || td?.destroy ? undefined : provider.scopeFor(handle.id);
      if (scope)
        await store
          .merge(scope, { lastActivityMs: Date.now() })
          .catch(swallowAs("modal-sandbox: record activity", undefined));
    },

    async computerStatus(scopeId: string): Promise<ComputerStatus> {
      scopeByName.set(nameFor(scopeId), scopeId);
      const [status, rec] = await Promise.all([provider.computerStatus!(scopeId), store.get(scopeId)]);
      return {
        ...status,
        ...(status.provisioned && rec?.expiresAtMs ? { expiresAtMs: rec.expiresAtMs } : {}),
        ...(status.recovery && rec?.checkpointAtMs
          ? {
              recovery: {
                ...status.recovery,
                checkpointExpiresAtMs: rec.checkpointAtMs + MODAL_CHECKPOINT_RETENTION_MS,
              },
            }
          : {}),
      };
    },

    async restartComputer(scopeId: string): Promise<void> {
      const name = nameFor(scopeId);
      scopeByName.set(name, scopeId);
      await provider.lifecycle(scopeId, async () => {
        const rec = await store.get(scopeId);
        if (!rec) return;
        if (!rec.initializationPending && (await client.fromName(name)))
          await provider.captureCheckpoint(scopeId, name);
        await destroy(name);
        await store.merge(scopeId, { initializationPending: undefined, snapshotError: undefined });
      });
    },

    async reapDeepIdle(idleMs: number): Promise<{ reaped: number }> {
      if (!(idleMs > 0)) return { reaped: 0 };
      const now = Date.now();
      const cutoff = now - Math.min(idleMs, opts.idleParkSec ? opts.idleParkSec * 1000 : DEFAULT_IDLE_REAP_MS);
      let reaped = 0;
      for (const [scope, rec] of await store.entries()) {
        if ((rec.orgId && rec.orgId !== configOrgId()) || rec.initializationPending) continue;
        const name = nameFor(scope);
        scopeByName.set(name, scope);
        let session: ModalSession | null;
        try {
          session = await client.fromName(name);
        } catch (e) {
          report("sandbox_reap", "deep_idle_probe_failed", e, scope);
          continue;
        }
        if (!session) {
          await forgetGone(scope, name, rec, now).catch((e) =>
            report("sandbox_reap", "deep_idle_reap_failed", e, scope),
          );
          continue;
        }
        if (rec.expiresAtMs && rec.expiresAtMs - now <= RETIRE_MARGIN_MS) {
          reaped += await retire(scope, name, rec);
          continue;
        }
        if (rec.lastActivityMs && rec.lastActivityMs <= cutoff) {
          let running: boolean;
          try {
            running = await busy(session, name);
          } catch (e) {
            if (!(e instanceof ModalSandboxGoneError)) report("sandbox_reap", "deep_idle_probe_failed", e, scope);
            continue;
          }
          if (!running) {
            reaped += await retire(scope, name, rec, cutoff);
            continue;
          }
        }
        await refresh(scope, name, rec, now);
      }
      return { reaped: reaped + (await sweepOrphans(now)) };
    },
  };
}
