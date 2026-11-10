import type { ChildIsolation, Principal, Resolution, ScopeId, Session } from "../../types.ts";
import {
  type ProvisionOptions,
  type SandboxHandle,
  supportsProcessSessions,
  SandboxProvisionCleanupError,
} from "../../sandbox/sandbox.ts";
import {
  assertBotMayUseComputer,
  createTurnSandboxAccess,
  preferredBackend,
  type SandboxAccessPlan,
  type SandboxResource,
} from "../../sandbox/sandbox-resources.ts";
import { ensureChildSandbox, prepareChildWorkdir } from "../../sessions/child-isolation.ts";
import { reconcileProcesses } from "../../processes/reconcile.ts";
import { leaseLapsed } from "../../runs/run-store.ts";
import { finishProcessCredentials } from "../../credentials/execute-files.ts";
import type { SkillResolution } from "../../skills/skill-store.ts";
import { createTurnSkills } from "../../skills/turn-skills.ts";
import { clearStaleTurnFiles } from "../attachments.ts";
import { errMessage, swallow, swallowAs } from "../../util/errors.ts";
import { sleep } from "../../util/async.ts";
import { tracePhase } from "../../../plugins/chassis/src/error-reporting.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";

const SCOPED = "scoped";
const SCRATCH = "scratch";

interface Slot {
  opening: Promise<SandboxHandle> | null;
  pending: boolean;
  ready: SandboxHandle | null;
  policy?: string;
  ephemeral: boolean;
  handles: SandboxHandle[];
}

interface Release {
  handle: SandboxHandle;
  scoped: boolean;
  unchanged: boolean;
  ephemeral: [string, Slot] | undefined;
}

export interface TurnSandboxContext {
  deps: OrchestratorDeps;
  input: OrchestratorInput;
  actor: Principal;
  session: Session;
  resolution: Resolution;
  scopeId: ScopeId;
  memoryScopeId: ScopeId;
  transferId: string;
  swarmSandboxId: string | undefined;
  turnSessionDir: string;
  turnFilesDir: string;
  connectorEnv: Record<string, string>;
  egressTokenForTurn: string | undefined;
  egressTokenForPolicy: (policy: Resolution["egress"]) => Promise<string | undefined>;
  openResourceAccess?: boolean;
  visibleSkillsForTurn: (sources?: readonly string[]) => Promise<SkillResolution[]>;
}

async function retried(label: string, attempt: () => Promise<void>): Promise<void> {
  const errors: unknown[] = [];
  for (let n = 1; n <= 3; n++) {
    try {
      return await attempt();
    } catch (error) {
      errors.push(error);
      if (n < 3) await sleep(50 * n);
    }
  }
  throw new AggregateError(errors, label);
}

interface TurnPool {
  ctx: TurnSandboxContext;
  pool: Map<string, Slot>;
  writableScopeId: ScopeId;
  scopedUsed: () => boolean;
  audit: (action: string, handle?: SandboxHandle, extra?: Record<string, unknown>) => void;
  isolation: ChildIsolation | undefined;
  boundSandboxId: string | undefined;
  assertDefaultUsable: (sandboxId?: string) => Promise<void>;
  turnAccess: ProvisionOptions;
  scratchKey: () => string;
  holdResource: (handle: SandboxHandle) => Promise<void>;
  prepareTurnFiles: (handle: SandboxHandle) => Promise<void>;
  finishProcess: (handle: SandboxHandle, processId: string) => Promise<void>;
  accessResource: (id: string) => Promise<SandboxAccessPlan>;
}

async function releasePool(t: TurnPool): Promise<void> {
  const { deps, input, session, scopeId, turnFilesDir } = t.ctx;
  const { pool, writableScopeId, scopedUsed, audit } = t;
  const releaseHold = async (handle: SandboxHandle): Promise<boolean> => {
    const runs = deps.runs;
    if (!handle.resourceId || !runs || !deps.sandboxResources) return false;
    return deps.sandboxResources.release(handle.resourceId, input.runId, async (runId) => {
      const run = await runs.get(runId);
      return run?.status === "running" && !leaseLapsed(run, Date.now());
    });
  };
  const clearTurnFiles = (handle: SandboxHandle): Promise<void> =>
    retried("turn file cleanup failed", () => deps.sandbox.removeDir(handle, turnFilesDir)).catch((err: unknown) =>
      swallow("orchestrator: turn file cleanup", err),
    );
  const releaseHandle = async (
    { handle, scoped, unchanged }: Release,
    hasLiveJob: (handle: SandboxHandle) => Promise<boolean>,
  ): Promise<void> => {
    if (scoped || handle.scopeId === undefined || handle.scopeId === writableScopeId || handle.scopeId === scopeId)
      await clearTurnFiles(handle);
    const keepWarm =
      (await releaseHold(handle).catch(swallowAs("orchestrator: hold release", true))) ||
      (await hasLiveJob(handle).catch(swallowAs("orchestrator: live process check", true)));
    await deps.sandbox
      .teardown(handle, {
        ...(keepWarm ? { keepWarm: true } : {}),
        ...(unchanged ? { homeUnchanged: true } : {}),
      })
      .catch((error: unknown) => {
        const message = `${handle.backend}:${handle.id}: ${errMessage(error)}`;
        swallow(`orchestrator: teardown ${message}`, error);
        deps.errors?.record(
          { category: "sandbox", code: "teardown_failed", message, scopeLabel: scopeId, sessionId: session.id },
          error,
        );
      });
  };
  const destroyHandle = async ([key, slot]: [string, Slot], handle: SandboxHandle): Promise<void> => {
    const cleanupStart = Date.now();
    try {
      await retried("Disposable sandbox destruction failed", () => deps.sandbox.teardown(handle, { destroy: true }));
      audit("scratch.released", handle, { cleanupMs: Date.now() - cleanupStart });
    } catch (error) {
      if (!pool.has(key)) pool.set(key, slot);
      const message = errMessage(error);
      audit("scratch.release_failed", handle, { cleanupMs: Date.now() - cleanupStart, error: message });
      deps.errors?.record(
        { category: "sandbox", code: "scratch_destroy_failed", message, scopeLabel: scopeId, sessionId: session.id },
        error,
      );
      throw error;
    }
  };
  const opening = () => [...pool.values()].flatMap((slot) => (slot.pending && slot.opening ? [slot.opening] : []));
  for (let waiting = opening(); waiting.length; waiting = opening())
    await Promise.all(waiting.map((open) => open.catch(swallowAs("orchestrator: provision", undefined))));
  const slots = [...pool];
  pool.clear();
  const targets = new Map<string, Release>();
  for (const [key, slot] of slots)
    for (const handle of slot.handles) {
      const id = `${handle.backend}:${handle.id}`;
      const seen = targets.get(id);
      const scoped = key === SCOPED;
      targets.set(id, {
        handle: seen?.scoped ? seen.handle : handle,
        scoped: scoped || !!seen?.scoped,
        unchanged: (seen?.unchanged ?? true) && scoped && !scopedUsed(),
        ephemeral: slot.ephemeral ? [key, slot] : seen?.ephemeral,
      });
    }
  let live: Promise<Set<string | undefined>> | undefined;
  const hasLiveJob = async (handle: SandboxHandle): Promise<boolean> => {
    if (!deps.processes || !handle.resourceId) return false;
    live ??= deps.processes.listLive().then((processes) => new Set(processes.map((p) => p.sandboxId)));
    return (await live).has(handle.resourceId);
  };
  const released = await Promise.allSettled(
    [...targets.values()].map((target) =>
      target.ephemeral
        ? destroyHandle(target.ephemeral, target.handle)
        : releaseHandle(target, hasLiveJob).catch(swallowAs("orchestrator: release", undefined)),
    ),
  );
  for (const result of released) if (result.status === "rejected") throw result.reason;
}

function openSlot(
  pool: Map<string, Slot>,
  key: string,
  create: (slot: Slot) => Promise<SandboxHandle>,
  { policy, ephemeral = false }: { policy?: string; ephemeral?: boolean } = {},
): Promise<SandboxHandle> {
  const slot = pool.get(key) ?? { opening: null, pending: false, ready: null, ephemeral, handles: [] };
  pool.set(key, slot);
  slot.pending = true;
  const opening: Promise<SandboxHandle> = create(slot).then(
    (handle) => {
      Object.assign(slot, { ready: handle, policy, pending: false });
      return handle;
    },
    (error: unknown) => {
      slot.pending = false;
      if (slot.opening === opening) slot.opening = slot.ready && Promise.resolve(slot.ready);
      throw error;
    },
  );
  slot.opening = opening;
  return opening;
}

async function openScoped(t: TurnPool, slot: Slot, eager: boolean): Promise<SandboxHandle> {
  const { deps, input, actor, session, resolution, scopeId, memoryScopeId } = t.ctx;
  const {
    isolation,
    boundSandboxId,
    assertDefaultUsable,
    turnAccess,
    holdResource,
    audit,
    prepareTurnFiles,
    finishProcess,
  } = t;
  if (input.surfaceOrigin?.audience === "external") {
    const resource = await deps.sandboxResources?.resolve(memoryScopeId);
    if (resource && resource.ownerScopeId !== scopeId) throw new Error("External Slack requires its own sandbox.");
  }
  if (isolation?.sandboxId)
    await ensureChildSandbox(deps.sandboxResources, {
      id: isolation.sandboxId,
      session,
      actorId: actor.id,
      scopeId: resolution.writableScopeId,
      backendScopeId: memoryScopeId,
    });
  await assertDefaultUsable();
  const handle = await deps.sandbox.provision(resolution.writableScopeId, {
    ...(boundSandboxId ? { sandboxId: boundSandboxId } : {}),
    ...turnAccess,
  });
  slot.handles.push(handle);
  await holdResource(handle);
  audit("scoped.provision_ready", handle, { coldStart: handle.coldStart, eager });
  await Promise.all([
    prepareTurnFiles(handle),
    prepareChildWorkdir(deps.sandbox, handle, isolation, deps.advisoryLock),
  ]);
  if (deps.processes && supportsProcessSessions(deps.sandbox)) {
    try {
      await reconcileProcesses(deps.sandbox, handle, deps.processes, memoryScopeId, finishProcess);
    } catch (err) {
      deps.errors?.record(
        {
          category: "process_session",
          code: "reconcile_failed",
          message: errMessage(err),
          scopeLabel: scopeId,
          sessionId: session.id,
        },
        err,
      );
    }
  }
  return handle;
}

function openScratch(t: TurnPool): Promise<SandboxHandle> {
  const { deps, memoryScopeId } = t.ctx;
  const { pool, turnAccess, audit, scratchKey } = t;
  const cached = pool.get(SCRATCH);
  if (cached?.opening) return cached.opening;
  if (cached?.handles.length)
    return Promise.reject(new Error("Disposable sandbox initialization cleanup is still pending"));
  audit("scratch.provision_started");
  return openSlot(
    pool,
    SCRATCH,
    async (slot) => {
      try {
        const handle = await deps.sandbox.provision(memoryScopeId, { ...turnAccess, scratch: { key: scratchKey() } });
        slot.handles.push(handle);
        audit("scratch.provision_ready", handle);
        return handle;
      } catch (error) {
        if (error instanceof SandboxProvisionCleanupError) slot.handles.push(error.handle);
        audit("scratch.provision_failed", slot.handles[0], { error: errMessage(error) });
        throw error;
      }
    },
    { ephemeral: true },
  );
}

async function openResource(
  t: TurnPool,
  input: string | SandboxAccessPlan,
  authorize?: (access: SandboxAccessPlan) => void,
): Promise<SandboxHandle> {
  const { deps, connectorEnv, egressTokenForTurn, egressTokenForPolicy } = t.ctx;
  const { pool, writableScopeId, accessResource, holdResource, prepareTurnFiles } = t;
  const access = typeof input === "string" ? await accessResource(input) : input;
  const { resource, crossScope, egress, credentialScopeId } = access;
  const key = `sandbox:${resource.id}`;
  const cached = pool.get(key);
  if (cached?.pending) {
    await cached.opening;
    return openResource(t, resource.jobOnly ? input : resource.id, authorize);
  }
  authorize?.(access);
  const policy = JSON.stringify({ egress, credentialScopeId });
  if (cached?.ready && cached.policy === policy) return cached.ready;
  return openSlot(
    pool,
    key,
    async (slot) => {
      const egressToken = crossScope ? await egressTokenForPolicy(egress) : egressTokenForTurn;
      const handle = await deps.sandbox.provision(crossScope ? resource.ownerScopeId : writableScopeId, {
        sandboxId: resource.id,
        ...(!crossScope ? { env: connectorEnv } : {}),
        egress,
        ...(egressToken ? { egressToken } : {}),
      });
      slot.handles.push(handle);
      await holdResource(handle);
      if (!crossScope) await prepareTurnFiles(handle);
      return handle;
    },
    { policy },
  );
}

export function createTurnSandboxes(ctx: TurnSandboxContext) {
  const {
    deps,
    input,
    actor,
    session,
    resolution,
    scopeId,
    memoryScopeId,
    transferId,
    swarmSandboxId,
    turnSessionDir,
    connectorEnv,
    egressTokenForTurn,
    openResourceAccess,
    visibleSkillsForTurn,
  } = ctx;

  const isolation = session.spawnMeta?.isolation;
  const boundSandboxId = swarmSandboxId ?? isolation?.sandboxId;
  const swarms = input.botActor ? deps.swarms : undefined;
  const botMayUse =
    swarms &&
    ((resource: SandboxResource) =>
      swarms.botMayUseComputer(resource, { actorId: actor.id, threadRef: session.threadRef, sessionId: session.id }));
  const assertDefaultUsable = (sandboxId = boundSandboxId): Promise<void> =>
    assertBotMayUseComputer(deps.sandboxResources, resolution.writableScopeId, sandboxId, botMayUse);
  const turnAccess = {
    env: connectorEnv,
    egress: resolution.egress,
    ...(egressTokenForTurn ? { egressToken: egressTokenForTurn } : {}),
  };
  const pool = new Map<string, Slot>();
  let retiredSlots = 0;
  let scopedUsed = false;
  const scratchKey = () => `turn:${session.id}:${transferId}`;
  const audit = (action: string, handle?: SandboxHandle, extra?: Record<string, unknown>): void => {
    deps.auditLog?.record({
      at: Date.now(),
      principalId: actor.id,
      action: `sandbox.${action}`,
      resource: scratchKey(),
      scopeLabel: scopeId,
      detail: JSON.stringify({
        runId: input.runId,
        sessionId: session.id,
        backend: handle?.backend,
        sandboxId: handle?.id,
        ...extra,
      }),
    });
  };
  const holdResource = async (handle: SandboxHandle): Promise<void> => {
    if (handle.resourceId && deps.runs && input.runId)
      await deps.sandboxResources?.hold(handle.resourceId, input.runId);
  };
  const finishProcess = (handle: SandboxHandle, processId: string): Promise<void> =>
    finishProcessCredentials(
      { sandbox: deps.sandbox, processes: deps.processes!, ...(deps.keychain ? { keychain: deps.keychain } : {}) },
      handle,
      processId,
    );
  const provision = async (eager = false): Promise<SandboxHandle> => {
    if (!eager) scopedUsed = true;
    const opening = pool.get(SCOPED)?.opening;
    if (!opening)
      return openSlot(pool, SCOPED, (slot) => tracePhase("sandbox.provision", () => openScoped(turnPool, slot, eager)));
    const handle = await opening;
    await assertDefaultUsable(handle.resourceId ?? boundSandboxId);
    return handle;
  };
  const writableScopeId = resolution.writableScopeId;
  const { accessResource, jobComputerPlan } = createTurnSandboxAccess({
    deps,
    actor,
    resolution,
    scopeId,
    openResourceAccess,
    botMayUse,
  });
  const provisionJobComputer = async (): Promise<SandboxHandle> => {
    const resources = deps.sandboxResources!;
    const backend = await preferredBackend(resources, memoryScopeId);
    const resource = await resources.create(actor.id, memoryScopeId, backend, "background job", undefined, true);
    return provisionResource(jobComputerPlan(resource));
  };
  const provisionJobSandbox = async (id: string): Promise<SandboxHandle> => {
    const resource = await deps.sandboxResources!.get(id);
    return resource.jobOnly ? provisionResource(jobComputerPlan(resource)) : provisionResource(id);
  };
  const provisionResource = (
    input: string | SandboxAccessPlan,
    authorize?: (access: SandboxAccessPlan) => void,
  ): Promise<SandboxHandle> => openResource(turnPool, input, authorize);
  const provisionScratch = (): Promise<SandboxHandle> => openScratch(turnPool);
  const turnSkills = createTurnSkills({
    deps,
    scopeId,
    sessionId: session.id,
    turnSessionDir,
    visibleSkillsForTurn,
    accessResource,
    provisionResource,
    provision,
  });

  const prepareTurnFiles = async (handle: SandboxHandle): Promise<void> => {
    await Promise.all([turnSkills.pruneSkills(handle), clearStaleTurnFiles(deps.sandbox, handle, turnSessionDir)]);
  };
  const turnPool: TurnPool = {
    ctx,
    pool,
    writableScopeId,
    scopedUsed: () => scopedUsed,
    audit,
    isolation,
    boundSandboxId,
    assertDefaultUsable,
    turnAccess,
    scratchKey,
    holdResource,
    prepareTurnFiles,
    finishProcess,
    accessResource,
  };
  const reclaimBox = async (): Promise<void> => {
    while (pool.size) await releasePool(turnPool);
  };

  return {
    boundSandboxId,
    assertDefaultUsable,
    workdir: isolation?.workdir,
    provision,
    provisionScratch,
    provisionJobComputer,
    provisionJobSandbox,
    accessResource,
    provisionResource,
    useSkill: turnSkills.useSkill,
    reclaimBox,
    finishProcess,
    invalidateProvision: () => {
      const slot = pool.get(SCOPED);
      if (slot) {
        pool.delete(SCOPED);
        pool.set(`retired:${retiredSlots++}`, slot);
      }
      turnSkills.forgetLaidTrees();
    },
  };
}
