import { hashId } from "../../util/crypto.ts";
import type { Principal, Resolution, ScopeId, Session } from "../../types.ts";
import { personalScope } from "../../types.ts";
import { intersectEgressPolicies } from "../../resolution/egress-policy.ts";
import { isOpenScopeMember } from "../../resolution/sharing-access.ts";
import { type SandboxHandle, supportsProcessSessions, SandboxProvisionCleanupError } from "../../sandbox/sandbox.ts";
import {
  accessConversationSandbox,
  type SandboxAccessPlan,
  type SandboxResource,
} from "../../sandbox/sandbox-resources.ts";
import { reconcileProcesses } from "../../processes/reconcile.ts";
import { leaseLapsed } from "../../runs/run-store.ts";
import { finishProcessCredentials } from "../../credentials/execute-files.ts";
import {
  materializeSkillTree as laySkillTree,
  packRoot,
  rehomeSkillPaths,
  renderSkillBody,
  skillDir,
  SKILLS_ROOT,
} from "../../skills/materialize.ts";
import { safeSkillFilePath, type SkillResolution } from "../../skills/skill-store.ts";
import { isSafeSkillName } from "../../skills/skill-name.ts";
import type { SkillResult } from "../../tools/primitives.ts";
import { TURN_FILES_DIR } from "../attachments.ts";
import { errMessage, swallow, swallowAs } from "../../util/errors.ts";
import { sleep } from "../../util/async.ts";
import { tracePhase } from "../../../plugins/chassis/src/error-reporting.ts";
import { loadActiveBundles } from "./turn-helpers.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";

const TURN_FILES_MAX_AGE_MS = 24 * 60 * 60_000;
const SCOPED = "scoped";
const SCRATCH = "scratch";

interface Slot {
  opening: Promise<SandboxHandle> | null;
  pending: boolean;
  ready: SandboxHandle | null;
  policy?: string;
  handles: SandboxHandle[];
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
  egressTokenForPolicy?: (policy: Resolution["egress"]) => Promise<string | undefined>;
  openResourceAccess?: boolean;
  visibleSkillsForTurn: (sources?: readonly string[]) => Promise<SkillResolution[]>;
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
    turnFilesDir,
    connectorEnv,
    egressTokenForTurn,
    egressTokenForPolicy,
    openResourceAccess,
    visibleSkillsForTurn,
  } = ctx;

  const pool = new Map<string, Slot>();
  let retiredSlots = 0;
  let scopedUsed = false;
  const open = (
    key: string,
    create: (slot: Slot) => Promise<SandboxHandle>,
    policy?: string,
  ): Promise<SandboxHandle> => {
    const slot = pool.get(key) ?? { opening: null, pending: false, ready: null, handles: [] };
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
  };
  const scratchKey = () => `turn:${session.id}:${transferId}`;
  let scratchStartedAt: number | undefined;
  let scratchReadyAt: number | undefined;
  const recordScratchLifecycle = (
    action: string,
    handle?: SandboxHandle,
    extra?: { releasedAt?: number; cleanupMs?: number; error?: string },
  ): void => {
    deps.auditLog?.record({
      at: Date.now(),
      principalId: actor.id,
      action: `sandbox.scratch.${action}`,
      resource: scratchKey(),
      scopeLabel: scopeId,
      detail: JSON.stringify({
        runId: input.runId,
        sessionId: session.id,
        backend: handle?.backend,
        sandboxId: handle?.id,
        startedAt: scratchStartedAt,
        readyAt: scratchReadyAt,
        ...extra,
      }),
    });
  };
  const destroyEphemeralHandle = async (handle: SandboxHandle): Promise<void> => {
    const errors: unknown[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await deps.sandbox.teardown(handle, { destroy: true });
        return;
      } catch (error) {
        errors.push(error);
        if (attempt < 3) await sleep(50 * attempt);
      }
    }
    throw new AggregateError(errors, "Disposable sandbox destruction failed");
  };
  const holdResource = async (handle: SandboxHandle): Promise<void> => {
    if (handle.resourceId && deps.runs && input.runId)
      await deps.sandboxResources?.hold(handle.resourceId, input.runId);
  };
  const releaseHold = async (handle: SandboxHandle): Promise<boolean> => {
    const runs = deps.runs;
    if (!handle.resourceId || !runs || !deps.sandboxResources) return false;
    return deps.sandboxResources.release(handle.resourceId, input.runId, async (runId) => {
      const run = await runs.get(runId);
      return run?.status === "running" && !leaseLapsed(run, Date.now());
    });
  };
  const provision = (eager = false): Promise<SandboxHandle> => {
    if (!eager) scopedUsed = true;
    return (
      pool.get(SCOPED)?.opening ??
      open(SCOPED, (slot) => tracePhase("sandbox.provision", () => openScoped(slot, eager)))
    );
  };
  const openScoped = async (slot: Slot, eager: boolean): Promise<SandboxHandle> => {
    if (input.externalSlack) {
      const resource = await deps.sandboxResources?.resolve(memoryScopeId);
      if (resource && resource.ownerScopeId !== scopeId) throw new Error("External Slack requires its own sandbox.");
    }
    const handle = await deps.sandbox.provision(resolution.layers, {
      ...(swarmSandboxId ? { sandboxId: swarmSandboxId } : {}),
      env: connectorEnv,
      egress: resolution.egress,
      ...(egressTokenForTurn ? { egressToken: egressTokenForTurn } : {}),
    });
    slot.handles.push(handle);
    await holdResource(handle);
    deps.auditLog?.record({
      at: Date.now(),
      principalId: actor.id,
      action: "sandbox.scoped.provision_ready",
      resource: scratchKey(),
      scopeLabel: scopeId,
      detail: JSON.stringify({
        runId: input.runId,
        sessionId: session.id,
        backend: handle.backend,
        sandboxId: handle.id,
        coldStart: handle.coldStart,
        eager,
      }),
    });
    await prepareTurnFiles(handle);
    if (deps.processes && supportsProcessSessions(deps.sandbox)) {
      try {
        await reconcileProcesses(deps.sandbox, handle, deps.processes, memoryScopeId, (exited, processId) =>
          finishProcessCredentials(
            {
              sandbox: deps.sandbox,
              processes: deps.processes!,
              ...(deps.keychain ? { keychain: deps.keychain } : {}),
            },
            exited,
            processId,
          ),
        );
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
  };
  const skillsRoot = (r: SkillResolution) =>
    `${SKILLS_ROOT}/${turnSessionDir.split("/").at(-1)}/${hashId([r.skill!.id, String(r.skill!.version)], 16)}`;
  const laidTrees = new Set<string>();
  const materializeSkillTree = async (handle: SandboxHandle, r: SkillResolution): Promise<void> => {
    const treeKey = `${handle.resourceId ?? handle.id}:${skillDir(skillsRoot(r), r)}`;
    if (laidTrees.has(treeKey)) return;
    try {
      const bundles = r.screenedBundles ?? (deps.skillBundles ? await loadActiveBundles(deps.skillBundles, [r]) : []);
      await laySkillTree(deps.sandbox, handle, skillsRoot(r), r, bundles);
      laidTrees.add(treeKey);
    } catch (err) {
      deps.errors?.record(
        {
          category: "skills",
          code: "tree_materialize_failed",
          message: errMessage(err),
          scopeLabel: scopeId,
          sessionId: session.id,
        },
        err,
      );
      throw err;
    }
  };
  const useSkill = async (name: string, file: string, sandboxId?: string, source?: string): Promise<SkillResult> => {
    const missing = { content: null, sourceScopeId: null };
    if (!isSafeSkillName(name)) return missing;
    try {
      if (safeSkillFilePath(file) !== file) return missing;
    } catch {
      return missing;
    }
    const resolution = (await visibleSkillsForTurn(source ? [source] : undefined)).find(
      (r) => r.skill?.manifest.name === name,
    );
    if (!resolution?.skill) return missing;
    const shipsFiles = (resolution.skill.manifest.files?.length ?? 0) > 0 || resolution.skill.pack !== undefined;
    const asset = resolution.skill.manifest.files?.find((f) => {
      try {
        return safeSkillFilePath(f.path) === file;
      } catch {
        return false;
      }
    })?.content;
    if (file !== "SKILL.md" && asset === undefined) return missing;
    if (deps.skills)
      void deps.skills.recordUse(resolution.skill.id).catch((e) => swallow("orchestrator: skill recordUse", e));
    const render = (root?: string) =>
      file === "SKILL.md"
        ? renderSkillBody(resolution, root)
        : rehomeSkillPaths(resolution, asset!, root ?? skillsRoot(resolution));
    if (!shipsFiles) return { content: render(), sourceScopeId: resolution.skill.scopeId };
    const access = sandboxId !== undefined ? await accessResource(sandboxId) : undefined;
    if (access?.crossScope) return { content: render(skillsRoot(resolution)), sourceScopeId: resolution.skill.scopeId };
    const handle = access ? await provisionResource(access) : await provision();
    await materializeSkillTree(handle, resolution);
    const root = `${handle.rootDir}/${skillsRoot(resolution)}`;
    const pack = packRoot(root, resolution);
    return {
      content: render(root),
      sourceScopeId: resolution.skill.scopeId,
      dir: skillDir(root, resolution),
      ...(pack ? { packDir: pack } : {}),
    };
  };
  const writableScopeId = resolution.layers.find((layer) => layer.mode === "rw")?.scopeId;
  const canUseSandboxScope = async (target: ScopeId): Promise<boolean> => {
    if (target === writableScopeId || target === scopeId) return true;
    if (!openResourceAccess || actor.type !== "internal" || !deps.config || !deps.isCurrentSharedScopeMember)
      return false;
    const personal = personalScope(actor.id);
    for (const scope of new Set([scopeId, target])) {
      if (scope === personal) {
        if ((await deps.config.resolveSharingPostureDurable(personal, scope)) !== "open") return false;
      } else if (
        !(await isOpenScopeMember({
          actorId: actor.id,
          scope,
          config: deps.config,
          isCurrentSharedScopeMember: deps.isCurrentSharedScopeMember,
        }))
      )
        return false;
    }
    return true;
  };
  const accessResource = async (id: string): Promise<SandboxAccessPlan> => {
    const resource = await accessConversationSandbox(deps.sandboxResources, actor.id, id, canUseSandboxScope);
    const crossScope = resource.ownerScopeId !== writableScopeId && resource.ownerScopeId !== scopeId;
    if (!crossScope) return { resource, crossScope: false, egress: resolution.egress, commandPolicy: null };
    await deps.config!.refreshSecurity([resource.ownerScopeId]);
    const credentialScopeId = resource.ownerScopeId === personalScope(actor.id) ? resource.ownerScopeId : undefined;
    return {
      resource,
      crossScope: true,
      egress: intersectEgressPolicies(resolution.egress, deps.config!.getEgress(resource.ownerScopeId)),
      commandPolicy: deps.config!.getCommandPolicy(resource.ownerScopeId),
      ...(credentialScopeId ? { credentialScopeId } : {}),
    };
  };
  const jobComputerPlan = (resource: SandboxResource): SandboxAccessPlan => ({
    resource,
    crossScope: false,
    egress: resolution.egress,
    commandPolicy: null,
  });
  const provisionJobComputer = async (): Promise<SandboxHandle> => {
    const resources = deps.sandboxResources!;
    const backend = (await resources.resolve(memoryScopeId))?.backend ?? resources.defaultBackend();
    const resource = await resources.create(actor.id, memoryScopeId, backend, "background job", undefined, true);
    return provisionResource(jobComputerPlan(resource));
  };
  const provisionJobSandbox = async (id: string): Promise<SandboxHandle> => {
    const resource = await deps.sandboxResources!.get(id);
    return resource.jobOnly ? provisionResource(jobComputerPlan(resource)) : provisionResource(id);
  };
  const provisionResource = async (
    input: string | SandboxAccessPlan,
    authorize?: (access: SandboxAccessPlan) => void,
  ): Promise<SandboxHandle> => {
    const access = typeof input === "string" ? await accessResource(input) : input;
    const { resource, crossScope, egress, credentialScopeId } = access;
    const key = `sandbox:${resource.id}`;
    const cached = pool.get(key);
    if (cached?.pending) {
      await cached.opening;
      return provisionResource(resource.jobOnly ? input : resource.id, authorize);
    }
    authorize?.(access);
    const policy = JSON.stringify({ egress, credentialScopeId });
    if (cached?.ready && cached.policy === policy) return cached.ready;
    return open(
      key,
      async (slot) => {
        const layers = crossScope
          ? resolution.layers
              .filter((layer) => layer.mode === "rw" || layer.mountPath === "global")
              .map((layer) => (layer.mode === "rw" ? { ...layer, scopeId: resource.ownerScopeId } : layer))
          : resolution.layers;
        if (crossScope && egressTokenForTurn && !egressTokenForPolicy)
          throw new Error("target sandbox egress authorization unavailable");
        const egressToken = crossScope ? await egressTokenForPolicy?.(egress) : egressTokenForTurn;
        const handle = await deps.sandbox.provision(layers, {
          sandboxId: resource.id,
          ...(!crossScope ? { env: connectorEnv } : {}),
          ...(access.env ? { env: { ...access.env } } : {}),
          egress,
          ...(egressToken ? { egressToken } : {}),
        });
        slot.handles.push(handle);
        await holdResource(handle);
        if (!crossScope) await prepareTurnFiles(handle);
        return handle;
      },
      policy,
    );
  };

  const provisionScratch = (): Promise<SandboxHandle> => {
    const cached = pool.get(SCRATCH);
    if (cached?.opening) return cached.opening;
    if (cached?.handles.length)
      return Promise.reject(new Error("Disposable sandbox initialization cleanup is still pending"));
    return open(SCRATCH, async (slot) => {
      scratchStartedAt = Date.now();
      recordScratchLifecycle("provision_started");
      try {
        const handle = await deps.sandbox.provision(
          resolution.layers.filter((l) => l.mode === "ro" && l.mountPath === "global"),
          {
            env: connectorEnv,
            egress: resolution.egress,
            ...(egressTokenForTurn ? { egressToken: egressTokenForTurn } : {}),
            scratch: { key: scratchKey() },
            routeScopeId: memoryScopeId,
          },
        );
        slot.handles.push(handle);
        scratchReadyAt = Date.now();
        recordScratchLifecycle("provision_ready", handle);
        return handle;
      } catch (error) {
        if (error instanceof SandboxProvisionCleanupError) slot.handles.push(error.handle);
        recordScratchLifecycle("provision_failed", slot.handles[0], { error: errMessage(error) });
        throw error;
      }
    });
  };
  const provisionForReach = (target: ScopeId): Promise<SandboxHandle> =>
    pool.get(`reach:${target}`)?.opening ??
    open(`reach:${target}`, async (slot) => {
      const handle = await deps.sandbox.provision(
        [
          { scopeId: resolution.orgScopeId, mountPath: "global", mode: "ro" },
          { scopeId: target, mountPath: "", mode: "rw" },
        ],
        {
          egress: resolution.egress,
          ...(egressTokenForTurn ? { egressToken: egressTokenForTurn } : {}),
        },
      );
      slot.handles.push(handle);
      await holdResource(handle);
      return handle;
    });
  const clearTurnFiles = async (handle: SandboxHandle): Promise<void> => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await deps.sandbox.removeDir(handle, turnFilesDir);
        return;
      } catch (err) {
        if (attempt === 3) swallow("orchestrator: turn file cleanup", err);
        else await sleep(50);
      }
    }
  };
  const pruneSkills = async (handle: SandboxHandle): Promise<void> => {
    const visible = (await visibleSkillsForTurn()).flatMap((r) => (r.skill ? [r.skill, ...r.shadowed] : []));
    const keep = new Set(visible.map((skill) => hashId([skill.id, String(skill.version)], 16)));
    const stale = new Set<string>();
    const listed = await deps.sandbox
      .listDir(handle, SKILLS_ROOT)
      .catch(swallowAs("orchestrator: list skills to prune", [] as string[]));
    for (const path of listed) {
      const [root, conversation, identity] = path.split("/");
      if (root === SKILLS_ROOT && conversation && identity && !keep.has(identity))
        stale.add(`${SKILLS_ROOT}/${conversation}/${identity}`);
    }
    await Promise.all(
      [...stale].map((dir) =>
        deps.sandbox.removeDir(handle, dir).catch(swallowAs("orchestrator: stale skill cleanup", undefined)),
      ),
    );
  };
  const clearStaleTurnFiles = async (handle: SandboxHandle): Promise<void> => {
    const cutoff = Date.now() - TURN_FILES_MAX_AGE_MS;
    const paths = deps.sandbox.removeDirAndList
      ? await deps.sandbox.removeDirAndList(handle, turnSessionDir, TURN_FILES_DIR)
      : await (async () => {
          await deps.sandbox.removeDir(handle, turnSessionDir);
          return deps.sandbox
            .listDir(handle, TURN_FILES_DIR)
            .catch(swallowAs("orchestrator: list stale turn files", [] as string[]));
        })();
    const stale = new Set<string>();
    for (const path of paths) {
      const parts = path.split("/");
      const startedAt = Number.parseInt(parts[2]?.split("-")[0] ?? "", 36);
      if (parts[0] === TURN_FILES_DIR && parts[1] && parts[2] && Number.isFinite(startedAt) && startedAt < cutoff) {
        stale.add(`${TURN_FILES_DIR}/${parts[1]}/${parts[2]}`);
      }
    }
    await Promise.all(
      [...stale].map((dir) =>
        deps.sandbox.removeDir(handle, dir).catch(swallowAs("orchestrator: stale turn file cleanup", undefined)),
      ),
    );
  };
  const prepareTurnFiles = async (handle: SandboxHandle): Promise<void> => {
    await Promise.all([pruneSkills(handle), clearStaleTurnFiles(handle)]);
  };
  const releaseHandle = async (
    { handle, scoped, unchanged }: { handle: SandboxHandle; scoped: boolean; unchanged: boolean },
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
  const destroyScratch = async (slot: Slot): Promise<void> => {
    const [handle] = slot.handles;
    if (!handle) return;
    const cleanupStart = Date.now();
    try {
      await destroyEphemeralHandle(handle);
      recordScratchLifecycle("released", handle, { releasedAt: Date.now(), cleanupMs: Date.now() - cleanupStart });
    } catch (error) {
      if (!pool.has(SCRATCH)) pool.set(SCRATCH, slot);
      const failure = error instanceof Error ? error : new Error(errMessage(error));
      recordScratchLifecycle("release_failed", handle, {
        releasedAt: Date.now(),
        cleanupMs: Date.now() - cleanupStart,
        error: errMessage(error),
      });
      deps.errors?.record(
        {
          category: "sandbox",
          code: "scratch_destroy_failed",
          message: errMessage(error),
          scopeLabel: scopeId,
          sessionId: session.id,
        },
        failure,
      );
      throw failure;
    }
  };
  const releasePool = async (): Promise<void> => {
    const opening = () => [...pool.values()].flatMap((slot) => (slot.pending && slot.opening ? [slot.opening] : []));
    for (let waiting = opening(); waiting.length; waiting = opening())
      await Promise.all(waiting.map((open) => open.catch(swallowAs("orchestrator: provision", undefined))));
    const slots = [...pool];
    pool.clear();
    const targets = new Map<string, { handle: SandboxHandle; scoped: boolean; unchanged: boolean }>();
    for (const [key, slot] of slots)
      for (const handle of key === SCRATCH ? [] : slot.handles) {
        const id = `${handle.backend}:${handle.id}`;
        const seen = targets.get(id);
        const scoped = key === SCOPED;
        targets.set(id, {
          handle: seen?.scoped ? seen.handle : handle,
          scoped: scoped || !!seen?.scoped,
          unchanged: (seen?.unchanged ?? true) && scoped && !scopedUsed,
        });
      }
    let live: Promise<Set<string | undefined>> | undefined;
    const hasLiveJob = async (handle: SandboxHandle): Promise<boolean> => {
      if (!deps.processes || !handle.resourceId) return false;
      live ??= deps.processes.listLive().then((processes) => new Set(processes.map((p) => p.sandboxId)));
      return (await live).has(handle.resourceId);
    };
    const scratch = slots.find(([key]) => key === SCRATCH)?.[1];
    const [destroyed] = await Promise.allSettled([
      scratch && destroyScratch(scratch),
      ...[...targets.values()].map((target) =>
        releaseHandle(target, hasLiveJob).catch(swallowAs("orchestrator: release", undefined)),
      ),
    ]);
    if (destroyed?.status === "rejected") throw destroyed.reason;
  };
  const reclaimBox = async (): Promise<void> => {
    while (pool.size) await releasePool();
  };

  return {
    provision,
    provisionScratch,
    provisionJobComputer,
    provisionJobSandbox,
    accessResource,
    provisionResource,
    useSkill,
    provisionForReach,
    reclaimBox,
    invalidateProvision: () => {
      const slot = pool.get(SCOPED);
      if (slot) {
        pool.delete(SCOPED);
        pool.set(`retired:${retiredSlots++}`, slot);
      }
      laidTrees.clear();
    },
  };
}
