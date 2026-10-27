import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { cols } from "../persistence/typed-table.ts";
import type { MapConversion } from "../persistence/typed-table.ts";
import { perTenant, tenant } from "../tenant.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { sleep } from "../util/async.ts";
import { createExecProcessSessions } from "./exec-process-session.ts";
import {
  MODAL_CHECKPOINT_RETENTION_MS,
  ModalNameConflictError,
  ModalSandboxGoneError,
  type ModalClient,
  type ModalSession,
} from "./modal-client.ts";
import {
  createProviderSandbox,
  sandboxNamePrefix,
  type ProviderSandbox,
  type SandboxDriver,
  type SandboxShared,
  type StoredSandboxRecord,
} from "./provider-sandbox.ts";
import type { BackendSandbox, ComputerStatus, ExecResult, SandboxHandle, TeardownOptions } from "./sandbox.ts";
import { sandboxBodiesMigration, type SandboxBodies } from "./sandbox-bodies.ts";

const HOME_DIR = "/root";
const ROTATE_MARGIN_MS = 4 * 3600_000;
const RETIRE_MARGIN_MS = 30 * 60_000;
const ROTATION_HOLD_MS = 10 * 60_000;
const NAME_RELEASE_WAIT_MS = 30_000;
const NAME_RETRY_MS = 500;
const RENEW_MARGIN_MS = 7 * 24 * 3600_000;
const ORPHAN_GRACE_MS = 10 * 60_000;
const ACTIVITY_TOUCH_INTERVAL_MS = 10 * 60_000;
const DEFAULT_IDLE_REAP_MS = 6 * 3600_000;
const DEFAULT_SNAPSHOT_INTERVAL_SEC = 300;
export interface StoredModalSandbox extends StoredSandboxRecord {
  sandboxId?: string;
  createdAtMs?: number;
  expiresAtMs?: number;
  lastActivityMs?: number;
  orgId?: string;
}

export interface ModalSandboxOptions extends SandboxShared {
  client: ModalClient;
  store: SandboxBodies<StoredModalSandbox>;
}

const RETIRED_KEYS = [
  "hydrationPending",
  "nativeSnapshotId",
  "nativeSnapshotExpiresAtMs",
  "recoveryError",
  "snapshotGeneration",
  "lastSnapshotAttemptMs",
].map((k) => `'${k}'`);

const typed = sandboxBodiesMigration(
  "modal_sandbox_bodies",
  cols(`sandboxId text, createdAtMs bigint, expiresAtMs bigint, lastActivityMs bigint, orgId text`),
);

export const MODAL_BODIES: MapConversion = {
  ...typed,
  statements: [
    `DO $legacy$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('modal_sandbox_bodies') AND attname = 'json' AND NOT attisdropped) THEN
        UPDATE modal_sandbox_bodies SET json = (json - ${RETIRED_KEYS.join(" - ")})
          || CASE WHEN json->>'hydrationPending' = 'true' THEN '{"initializationPending": true}'::jsonb ELSE '{}'::jsonb END
          || CASE WHEN coalesce(json->>'nativeSnapshotId', '') <> '' THEN jsonb_strip_nulls(jsonb_build_object(
               'checkpointId', json->'nativeSnapshotId',
               'checkpointAtMs', coalesce(
                 (nullif(json->>'nativeSnapshotExpiresAtMs', '0'))::bigint - ${MODAL_CHECKPOINT_RETENTION_MS},
                 (json->>'lastSnapshotMs')::bigint)))
             ELSE '{}'::jsonb END
          || CASE WHEN coalesce(json->>'recoveryError', '') <> '' THEN jsonb_build_object('snapshotError', json->'recoveryError')
             ELSE '{}'::jsonb END
         WHERE json ?| array[${RETIRED_KEYS.join(", ")}];
      END IF;
    END $legacy$`,
    ...typed.statements,
  ],
};

type ModalCtx = ReturnType<typeof modalCtx>;

function modalCtx(opts: ModalSandboxOptions, provider: () => ProviderSandbox) {
  const { client } = opts;
  const { store } = opts;
  const nameFor = (scope: string): string => provider().nameFor(scope);
  const snapshotIntervalMs = (opts.snapshotIntervalSec ?? DEFAULT_SNAPSHOT_INTERVAL_SEC) * 1000;
  const lock = opts.advisoryLock;
  const sessions = new Map<string, ModalSession>();
  const scratchNames = new Set<string>();
  const rotationHold = new Map<string, number>();
  const lastTouch = perTenant(() => new Map<string, number>());
  const refreshAttempt = perTenant(() => new Map<string, number>());
  const orphanFirstSeen = new Map<string, number>();
  const tags = (kind: "scope" | "scratch"): Record<string, string> => ({
    "qm-org": tenant().orgId,
    "qm-prefix": sandboxNamePrefix(opts),
    "qm-kind": kind,
  });
  const report = (category: string, code: string, e: unknown, scopeLabel?: string): void => {
    opts.onError?.({ category, code, message: errMessage(e), ...(scopeLabel ? { scopeLabel } : {}) });
  };
  const sharedUse = <T>(scope: string, fn: () => Promise<T>): Promise<T> =>
    (lock.withSharedLock ?? lock.withLock)(`modal-use:${scope}`, fn);
  const exclusiveUse = <T>(scope: string, fn: () => Promise<T>): Promise<T> => lock.withLock(`modal-use:${scope}`, fn);
  return {
    opts,
    provider,
    client,
    store,
    sessions,
    scratchNames,
    rotationHold,
    lastTouch,
    refreshAttempt,
    orphanFirstSeen,
    snapshotIntervalMs,
    tags,
    report,
    sharedUse,
    exclusiveUse,
    nameFor,
  };
}

async function current(ctx: ModalCtx, name: string): Promise<ModalSession> {
  const { client, sessions, scratchNames } = ctx;
  const cached = sessions.get(name);
  if (cached) return cached;
  const found = scratchNames.has(name) ? null : await client.fromName(name);
  if (!found) throw new ModalSandboxGoneError(name, "no running sandbox holds this name");
  sessions.set(name, found);
  return found;
}

async function claimName(ctx: ModalCtx, name: string): Promise<ModalSession> {
  const { client, tags } = ctx;
  const deadline = Date.now() + NAME_RELEASE_WAIT_MS;
  for (;;) {
    try {
      return await client.create({ name, tags: tags("scope") });
    } catch (e) {
      if (!(e instanceof ModalNameConflictError)) throw e;
      const adopted = await client.fromName(name);
      if (adopted) return adopted;
      if (Date.now() >= deadline) throw e;
      await sleep(NAME_RETRY_MS);
    }
  }
}

async function createScratch(ctx: ModalCtx, name: string): Promise<ModalSession> {
  const { client, sessions, scratchNames, tags } = ctx;
  const session = await client.create({ tags: tags("scratch") });
  sessions.set(name, session);
  scratchNames.add(name);
  return session;
}

async function touch(ctx: ModalCtx, scope: string): Promise<void> {
  const { store, lastTouch } = ctx;
  const now = Date.now();
  if (now - (lastTouch().get(scope) ?? 0) < ACTIVITY_TOUCH_INTERVAL_MS) return;
  lastTouch().set(scope, now);
  await store.update(scope, { lastActivityMs: now }).catch(swallowAs("modal-sandbox: record activity", undefined));
}

async function withSession<T>(ctx: ModalCtx, name: string, action: (session: ModalSession) => Promise<T>): Promise<T> {
  const { store, sessions, scratchNames, sharedUse } = ctx;
  const provider = ctx.provider();
  if (scratchNames.has(name)) {
    try {
      return await action(await current(ctx, name));
    } catch (e) {
      if (!(e instanceof ModalSandboxGoneError)) throw e;
      return action(await createScratch(ctx, name));
    }
  }
  const scope = provider.scopeFor(name);
  if (!scope) throw new Error("sandbox handle has been released");
  await touch(ctx, scope);
  try {
    return await sharedUse(scope, async () => action(await current(ctx, name)));
  } catch (e) {
    if (!(e instanceof ModalSandboxGoneError)) throw e;
    sessions.delete(name);
    if ((await store.get(scope))?.initializationPending) throw e;
    await provider.ensureResident(scope);
    return sharedUse(scope, async () => action(await current(ctx, name)));
  }
}

async function exec(ctx: ModalCtx, name: string, script: string, timeoutSec: number, env?: Record<string, string>) {
  return withSession(ctx, name, async (session): Promise<ExecResult> => {
    const r = await session.runCommand(script, { timeoutMs: timeoutSec * 1000, ...(env ? { env } : {}) });
    return { stdout: r.stdout, stderr: r.stderr, code: r.exitCode, timedOut: r.exitCode === 124 };
  });
}

async function destroy(ctx: ModalCtx, name: string): Promise<void> {
  const { client, store, sessions, scratchNames } = ctx;
  const provider = ctx.provider();
  const cached = sessions.get(name);
  if (cached) await cached.terminate();
  if (!scratchNames.has(name)) {
    const ids = new Set<string>();
    const found = await client.fromName(name);
    if (found) ids.add(found.sandboxId);
    const scope = await provider.scopeOf(name);
    const stored = scope ? (await store.get(scope))?.sandboxId : undefined;
    if (stored) ids.add(stored);
    if (cached) ids.delete(cached.sandboxId);
    for (const id of ids) await client.terminate(id);
  }
  sessions.delete(name);
  scratchNames.delete(name);
}

function modalDriver(ctx: ModalCtx): SandboxDriver {
  const { client, store, sessions, scratchNames, rotationHold, opts } = ctx;
  const provider = (): ProviderSandbox => ctx.provider();
  return {
    backend: "modal",
    homeDir: HOME_DIR,
    os: "Debian 12 — Modal sandbox (24h max lifetime; home checkpoints have limited retention; publish durable work to git or Files)",
    ...(opts.cpus ? { cpus: opts.cpus } : {}),
    ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
    writablePersistence: "provider_managed",
    egressEnforcement: opts.egressProxyUrl ? "domain" : "none",
    envViaExec: true,
    exec: (name, script, timeoutSec, env) => exec(ctx, name, script, timeoutSec, env),
    writeAbsBytes: (name, absPath, data) => withSession(ctx, name, (session) => session.writeFileBytes(absPath, data)),
    readAbsBytes: (name, absPath) => withSession(ctx, name, (session) => session.readFileBytes(absPath)),
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
        await createScratch(ctx, name);
        return;
      }
      const session = await claimName(ctx, name);
      sessions.set(name, session);
      const scope = await provider().scopeOf(name);
      const now = Date.now();
      if (scope)
        await store.update(scope, {
          sandboxId: session.sandboxId,
          createdAtMs: now,
          expiresAtMs: now + client.lifetimeMs,
          orgId: tenant().orgId,
        });
    },
    resume: async () => {},
    destroy: (name) => destroy(ctx, name),
    isLive: (name) => scratchNames.has(name) && sessions.has(name),
    async rotationDue(name) {
      const scope = await provider().scopeOf(name);
      const expiresAtMs = scope ? (await store.get(scope))?.expiresAtMs : undefined;
      const now = Date.now();
      if (!expiresAtMs || expiresAtMs - now > ROTATE_MARGIN_MS || now < (rotationHold.get(name) ?? 0)) return false;
      rotationHold.set(name, now + ROTATION_HOLD_MS);
      return true;
    },
    checkpoints: {
      capture: async (name) => (await current(ctx, name)).snapshotHome(),
      async restore(name, checkpointId) {
        const scope = await provider().scopeOf(name);
        const checkpointAtMs = scope ? (await store.get(scope))?.checkpointAtMs : undefined;
        if (checkpointAtMs && checkpointAtMs + MODAL_CHECKPOINT_RETENTION_MS <= Date.now())
          throw new Error(
            "Modal home checkpoint has expired; explicitly import a recovery snapshot before creating a replacement",
          );
        await (await current(ctx, name)).restoreHome(checkpointId);
      },
      drop: async () => {},
    },
  };
}

const renewalDue = (rec: StoredModalSandbox, now: number): boolean => {
  if (!rec.checkpointId || !rec.checkpointAtMs) return false;
  const remaining = rec.checkpointAtMs + MODAL_CHECKPOINT_RETENTION_MS - now;
  return remaining > 0 && remaining <= RENEW_MARGIN_MS;
};

async function renew(ctx: ModalCtx, scope: string, name: string, rec: StoredModalSandbox): Promise<void> {
  const { store, report } = ctx;
  const provider = ctx.provider();
  try {
    await provider.ensureResident(scope);
    await provider.lifecycle(scope, () => provider.captureCheckpoint(scope, name));
    await provider.lifecycle(scope, async () => {
      const after = await store.get(scope);
      if (after && !after.initializationPending && after.lastActivityMs === rec.lastActivityMs)
        await destroy(ctx, name);
    });
  } catch (e) {
    if (!(e instanceof ModalSandboxGoneError)) report("sandbox_snapshot", "checkpoint_renewal_failed", e, scope);
  }
}

function retire(
  ctx: ModalCtx,
  scope: string,
  name: string,
  rec: StoredModalSandbox,
  idleCutoffMs?: number,
): Promise<number> {
  const { store, sessions, report, exclusiveUse } = ctx;
  const provider = ctx.provider();
  return provider.lifecycle(scope, () =>
    exclusiveUse(scope, async () => {
      const now = await store.get(scope);
      if (!now || now.initializationPending || now.sandboxId !== rec.sandboxId) return 0;
      if (idleCutoffMs !== undefined && (!now.lastActivityMs || now.lastActivityMs > idleCutoffMs)) return 0;
      try {
        await provider.captureCheckpoint(scope, name);
        await destroy(ctx, name);
        return 1;
      } catch (e) {
        if (e instanceof ModalSandboxGoneError) sessions.delete(name);
        else report("sandbox_reap", "deep_idle_reap_failed", e, scope);
        return 0;
      }
    }),
  );
}

async function forgetGone(
  ctx: ModalCtx,
  scope: string,
  name: string,
  rec: StoredModalSandbox,
  now: number,
): Promise<void> {
  const { client, store, sessions } = ctx;
  const provider = ctx.provider();
  sessions.delete(name);
  if (rec.checkpointId) {
    if (renewalDue(rec, now)) await renew(ctx, scope, name, rec);
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

async function refresh(
  ctx: ModalCtx,
  scope: string,
  name: string,
  rec: StoredModalSandbox,
  now: number,
): Promise<void> {
  const { store, refreshAttempt, snapshotIntervalMs, report } = ctx;
  const provider = ctx.provider();
  if (now - Math.max(rec.lastSnapshotMs ?? 0, refreshAttempt().get(scope) ?? 0) <= snapshotIntervalMs) return;
  refreshAttempt().set(scope, now);
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

async function sweepOrphans(ctx: ModalCtx, now: number): Promise<number> {
  const { client, store, sessions, orphanFirstSeen, tags, report } = ctx;
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

async function reapDeepIdle(ctx: ModalCtx, idleMs: number): Promise<{ reaped: number }> {
  const { client, store, report, nameFor, opts } = ctx;
  if (!(idleMs > 0)) return { reaped: 0 };
  const now = Date.now();
  const cutoff = now - Math.min(idleMs, opts.idleParkSec ? opts.idleParkSec * 1000 : DEFAULT_IDLE_REAP_MS);
  let reaped = 0;
  for (const [scope, rec] of await store.entries()) {
    if ((rec.orgId && rec.orgId !== tenant().orgId) || rec.initializationPending) continue;
    const name = nameFor(scope);
    let session: ModalSession | null;
    try {
      session = await client.fromName(name);
    } catch (e) {
      report("sandbox_reap", "deep_idle_probe_failed", e, scope);
      continue;
    }
    if (!session) {
      await forgetGone(ctx, scope, name, rec, now).catch((e) =>
        report("sandbox_reap", "deep_idle_reap_failed", e, scope),
      );
      continue;
    }
    if (rec.expiresAtMs && rec.expiresAtMs - now <= RETIRE_MARGIN_MS) {
      reaped += await retire(ctx, scope, name, rec);
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
        reaped += await retire(ctx, scope, name, rec, cutoff);
        continue;
      }
    }
    await refresh(ctx, scope, name, rec, now);
  }
  return { reaped: reaped + (await sweepOrphans(ctx, now)) };
}

export function createModalSandbox(workspace: WorkspaceStore, opts: ModalSandboxOptions): BackendSandbox {
  const ctx = modalCtx(opts, () => provider);
  const { client, store, nameFor } = ctx;
  const provider: ProviderSandbox = createProviderSandbox(workspace, modalDriver(ctx), opts, store);

  return {
    ...provider,

    async teardown(handle: SandboxHandle, td?: TeardownOptions): Promise<void> {
      await provider.teardown(handle, td);
      const scope = handle.scratch || td?.destroy ? undefined : provider.scopeFor(handle.id);
      if (scope)
        await store
          .update(scope, { lastActivityMs: Date.now() })
          .catch(swallowAs("modal-sandbox: record activity", undefined));
    },

    async computerStatus(scopeId: string): Promise<ComputerStatus> {
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
      await provider.lifecycle(scopeId, async () => {
        const rec = await store.get(scopeId);
        if (!rec) return;
        if (!rec.initializationPending && (await client.fromName(name)))
          await provider.captureCheckpoint(scopeId, name);
        await destroy(ctx, name);
        await store.update(scopeId, { initializationPending: undefined, snapshotError: undefined });
      });
    },

    reapDeepIdle: (idleMs: number) => reapDeepIdle(ctx, idleMs),
  };
}
