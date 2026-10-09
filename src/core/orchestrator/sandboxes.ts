import type { Principal, Resolution, ScopeId, Session } from "../../types.ts";
import { personalScope } from "../../types.ts";
import { intersectEgressPolicies } from "../../resolution/egress-policy.ts";
import { isOpenScopeMember } from "../../resolution/sharing-access.ts";
import type { GapPhase } from "../../sessions/session-store.ts";
import { type SandboxHandle, supportsProcessSessions, SandboxProvisionCleanupError } from "../../sandbox/sandbox.ts";
import type { SandboxAccessPlan } from "../../sandbox/sandbox-resources.ts";
import { reconcileProcesses } from "../../processes/reconcile.ts";
import {
  materializeSkillTree as laySkillTree,
  packRoot,
  rehomeSkillPaths,
  renderSkillBody,
  skillDir,
  SKILLS_DIR,
} from "../../skills/materialize.ts";
import { safeSkillFilePath, type SkillResolution } from "../../skills/skill-store.ts";
import { isSafeSkillName } from "../../skills/skill-name.ts";
import type { SkillResult } from "../../tools/primitives.ts";
import { TURN_FILES_DIR } from "../attachments.ts";
import { errMessage, swallow, swallowAs } from "../../util/errors.ts";
import { sleep } from "../../util/async.ts";
import { loadActiveBundles } from "./turn-helpers.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";

const TURN_FILES_MAX_AGE_MS = 24 * 60 * 60_000;

export interface TurnSandboxContext {
  deps: OrchestratorDeps;
  input: OrchestratorInput;
  actor: Principal;
  session: Session;
  resolution: Resolution;
  scopeId: ScopeId;
  memoryScopeId: ScopeId;
  transferId: string;
  turnSessionDir: string;
  turnFilesDir: string;
  connectorEnv: Record<string, string>;
  egressTokenForTurn: string | undefined;
  egressTokenForPolicy?: (policy: Resolution["egress"]) => Promise<string | undefined>;
  openSpeakerKeychain?: boolean;
  openResourceAccess?: boolean;
  ownerAuthAvailable: boolean;
  credentialCutoverServices: string[];
  visibleSkillsForTurn: () => Promise<SkillResolution[]>;
  emitGapWork: (phase: GapPhase, start: number, end: number) => void;
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
    turnSessionDir,
    turnFilesDir,
    connectorEnv,
    egressTokenForTurn,
    egressTokenForPolicy,
    openSpeakerKeychain,
    openResourceAccess,
    ownerAuthAvailable,
    credentialCutoverServices,
    visibleSkillsForTurn,
    emitGapWork,
  } = ctx;

  let ownerAuthCommand: ((command: string, env?: Record<string, string>) => string) | undefined;
  const brokerEnvKeys = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
  ];
  const unsetBrokerEnv = (env: Record<string, string>): string => {
    const keys = brokerEnvKeys.filter((key) => !(key in env));
    return keys.length ? `unset ${keys.join(" ")}; ` : "";
  };
  const scopedCommand = credentialCutoverServices.length
    ? (command: string, env = connectorEnv): string => `${unsetBrokerEnv(env)}${command}`
    : undefined;
  if (ownerAuthAvailable) {
    ownerAuthCommand = (command, env = {}) => {
      if (openSpeakerKeychain)
        deps.auditLog.record({
          at: Date.now(),
          principalId: actor.id,
          action: "keychain.open_speaker_use",
          resource: "isolated owner execution",
          scopeLabel: scopeId,
        });
      return `unset AGENT_API_TOKEN AGENT_OAUTH_CONSENT_TOKEN AGENT_CREDENTIAL_TOKEN; ${unsetBrokerEnv(env)}${command}`;
    };
  }
  const box: {
    handle: SandboxHandle | null;
    pending: SandboxHandle | null;
    used: boolean;
    provisionMs?: number;
    materializeMs?: number;
  } = { handle: null, pending: null, used: false };
  const scratchBox: { handle: SandboxHandle | null; pending: SandboxHandle | null; provisionMs?: number } = {
    handle: null,
    pending: null,
  };
  let scratchProvisionInFlight: Promise<SandboxHandle> | null = null;
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
        provisionMs: scratchBox.provisionMs,
        ...extra,
      }),
    });
  };
  const ownerAuthBox: { handle: SandboxHandle | null; pending: SandboxHandle | null; provisionMs?: number } = {
    handle: null,
    pending: null,
  };
  let ownerAuthProvisionInFlight: Promise<SandboxHandle> | null = null;
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
  let sandboxStatusSeq = 2_000_000;
  const onSandboxStatus =
    input.runId && deps.runActivity
      ? (text: string): void => {
          void deps
            .runActivity!.append(input.runId!, {
              seq: sandboxStatusSeq++,
              parentSeq: null,
              type: "sandbox_status",
              payload: { text },
              createdAt: Date.now(),
            })
            .catch(swallowAs("orchestrator: sandbox status append", undefined));
        }
      : undefined;
  const resourceHandles = new Map<string, SandboxHandle>();
  const resourcePolicy = new Map<string, string>();
  const resourcePendingHandles = new Map<string, SandboxHandle>();
  const resourcePending = new Map<string, Promise<SandboxHandle>>();
  let provisionInFlight: Promise<SandboxHandle> | null = null;
  const provision = (eager = false): Promise<SandboxHandle> => {
    if (!eager) box.used = true;
    provisionInFlight ??= doProvision(eager ? () => {} : emitGapWork, eager).catch((err) => {
      provisionInFlight = null;
      throw err;
    });
    return provisionInFlight;
  };
  const doProvision = async (emit: typeof emitGapWork, eager: boolean): Promise<SandboxHandle> => {
    const provisionStart = Date.now();
    if (input.externalSlack) {
      const resource = await deps.sandboxResources?.resolve(memoryScopeId);
      if (resource && resource.ownerScopeId !== scopeId) throw new Error("External Slack requires its own sandbox.");
    }
    const swarmBinding = await deps.swarms?.binding(input);
    const handle = await deps.sandbox.provision(resolution.layers, {
      ...(swarmBinding?.sandboxId ? { sandboxId: swarmBinding.sandboxId } : {}),
      env: connectorEnv,
      egress: resolution.egress,
      ...(egressTokenForTurn ? { egressToken: egressTokenForTurn } : {}),
      ...(onSandboxStatus ? { onStatus: onSandboxStatus } : {}),
    });
    box.pending = handle;
    emit("provision", provisionStart, Date.now());
    box.provisionMs = Date.now() - provisionStart;
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
        provisionMs: box.provisionMs,
        coldStart: handle.coldStart,
        eager,
      }),
    });
    const dirCleanupStart = Date.now();
    await prepareTurnFiles(handle);
    emit("dir_cleanup", dirCleanupStart, Date.now());
    if (deps.processes && supportsProcessSessions(deps.sandbox)) {
      const procReconcileStart = Date.now();
      try {
        await reconcileProcesses(deps.sandbox, handle, deps.processes, memoryScopeId);
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
      } finally {
        emit("proc_reconcile", procReconcileStart, Date.now());
      }
    }
    box.handle = handle;
    return handle;
  };
  const skillsRoot = `${turnFilesDir}/${SKILLS_DIR}`;
  const laidTrees = new Set<string>();
  const materializeSkillTree = async (handle: SandboxHandle, r: SkillResolution, sandboxId?: string): Promise<void> => {
    const treeKey = `${sandboxId ?? "default"}:${skillDir(skillsRoot, r)}`;
    if (laidTrees.has(treeKey)) return;
    const start = Date.now();
    try {
      const bundles = r.screenedBundles ?? (deps.skillBundles ? await loadActiveBundles(deps.skillBundles, [r]) : []);
      await laySkillTree(deps.sandbox, handle, skillsRoot, r, bundles);
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
    } finally {
      emitGapWork("skills_materialize", start, Date.now());
    }
  };
  const useSkill = async (name: string, file: string, sandboxId?: string): Promise<SkillResult> => {
    const missing = { content: null, sourceScopeId: null };
    if (!isSafeSkillName(name)) return missing;
    try {
      if (safeSkillFilePath(file) !== file) return missing;
    } catch {
      return missing;
    }
    const resolution = (await visibleSkillsForTurn()).find((r) => r.skill?.manifest.name === name);
    if (!resolution?.skill) return missing;
    const shipsFiles = (resolution.skill.manifest.files?.length ?? 0) > 0 || resolution.skill.pack !== undefined;
    const asset = resolution.skill.manifest.files?.find((f) => {
      try {
        return safeSkillFilePath(f.path) === file;
      } catch {
        return false;
      }
    })?.content;
    let content: string | undefined;
    if (file === "SKILL.md") content = renderSkillBody(resolution, shipsFiles ? skillsRoot : undefined);
    else if (asset !== undefined) content = rehomeSkillPaths(resolution, asset, skillsRoot);
    if (content === undefined) return missing;
    if (deps.skills)
      void deps.skills.recordUse(resolution.skill.id).catch((e) => swallow("orchestrator: skill recordUse", e));
    if (!shipsFiles) return { content, sourceScopeId: resolution.skill.scopeId };
    const access = sandboxId ? await accessResource(sandboxId) : undefined;
    if (access?.crossScope) return { content, sourceScopeId: resolution.skill.scopeId };
    const handle = access ? await provisionResource(access) : await provision();
    await materializeSkillTree(handle, resolution, sandboxId);
    const pack = packRoot(skillsRoot, resolution);
    return {
      content,
      sourceScopeId: resolution.skill.scopeId,
      dir: skillDir(skillsRoot, resolution),
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
    const resource = await deps.sandboxResources?.access(actor.id, id);
    if (!resource || !(await canUseSandboxScope(resource.ownerScopeId)))
      throw new Error("sandbox access is no longer authorized in this conversation");
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
  const provisionResource = async (
    input: string | SandboxAccessPlan,
    authorize?: (access: SandboxAccessPlan) => void,
  ): Promise<SandboxHandle> => {
    const access = typeof input === "string" ? await accessResource(input) : input;
    const { resource, crossScope, egress, credentialScopeId } = access;
    const id = resource.id;
    const pending = resourcePending.get(id);
    if (pending) {
      await pending;
      return provisionResource(id, authorize);
    }
    authorize?.(access);
    const policyKey = JSON.stringify({ egress, credentialScopeId });
    const existing = resourceHandles.get(id);
    if (existing && resourcePolicy.get(id) === policyKey) {
      return existing;
    }
    const provisioned = (async () => {
      const layers = crossScope
        ? resolution.layers
            .filter((layer) => layer.mode === "rw" || layer.mountPath === "global")
            .map((layer) => (layer.mode === "rw" ? { ...layer, scopeId: resource.ownerScopeId } : layer))
        : resolution.layers;
      if (crossScope && egressTokenForTurn && !egressTokenForPolicy)
        throw new Error("target sandbox egress authorization unavailable");
      const egressToken = crossScope ? await egressTokenForPolicy?.(egress) : egressTokenForTurn;
      const handle = await deps.sandbox.provision(layers, {
        sandboxId: id,
        ...(!crossScope ? { env: connectorEnv } : {}),
        ...(access.env ? { env: { ...access.env } } : {}),
        egress,
        ...(egressToken ? { egressToken } : {}),
      });
      resourcePendingHandles.set(id, handle);
      if (!crossScope) {
        await prepareTurnFiles(handle);
      }
      resourceHandles.set(id, handle);
      resourcePolicy.set(id, policyKey);
      resourcePendingHandles.delete(id);
      return handle;
    })().finally(() => {
      resourcePending.delete(id);
    });
    resourcePending.set(id, provisioned);
    return provisioned;
  };

  const provisionScratch = (): Promise<SandboxHandle> => {
    if (scratchBox.pending)
      return Promise.reject(new Error("Disposable sandbox initialization cleanup is still pending"));
    if (scratchBox.handle) return Promise.resolve(scratchBox.handle);
    scratchProvisionInFlight ??= (async () => {
      const provisionStart = Date.now();
      scratchStartedAt = provisionStart;
      recordScratchLifecycle("provision_started");
      const handle = await deps.sandbox.provision(
        resolution.layers.filter((l) => l.mode === "ro" && l.mountPath === "global"),
        {
          env: connectorEnv,
          egress: resolution.egress,
          ...(egressTokenForTurn ? { egressToken: egressTokenForTurn } : {}),
          scratch: { key: scratchKey() },
          routeScopeId: memoryScopeId,
          ...(onSandboxStatus ? { onStatus: onSandboxStatus } : {}),
        },
      );
      scratchBox.provisionMs = Date.now() - provisionStart;
      scratchBox.handle = handle;
      scratchReadyAt = Date.now();
      recordScratchLifecycle("provision_ready", handle);
      return handle;
    })().catch((error) => {
      scratchProvisionInFlight = null;
      if (error instanceof SandboxProvisionCleanupError) scratchBox.pending = error.handle;
      recordScratchLifecycle("provision_failed", scratchBox.pending ?? undefined, { error: errMessage(error) });
      throw error;
    });
    return scratchProvisionInFlight;
  };
  const provisionOwnerAuth = ownerAuthAvailable
    ? async (): Promise<SandboxHandle> => {
        // Recheck each command, including commands reusing this turn's isolated computer.
        if (
          openSpeakerKeychain &&
          (!(await deps.isCurrentSharedScopeMember?.(actor.id, scopeId)) ||
            (await deps.config?.resolveSharingPostureDurable(personalScope(actor.id), scopeId)) !== "open")
        )
          throw new Error("Open speaker keychain access is no longer authorized");
        if (ownerAuthBox.handle) return ownerAuthBox.handle;
        if (ownerAuthBox.pending && !ownerAuthProvisionInFlight) {
          return Promise.reject(new Error("owner-auth box initialization failed and cleanup is still pending"));
        }
        ownerAuthProvisionInFlight ??= (async () => {
          const provisionStart = Date.now();
          const handle = await deps.sandbox.provision(
            resolution.layers.filter((l) => l.mode === "ro" && l.mountPath === "global"),
            {
              egress: resolution.egress,
              ...(egressTokenForTurn ? { egressToken: egressTokenForTurn } : {}),
              scratch: { key: `owner-auth:${session.id}:${transferId}` },
              routeScopeId: memoryScopeId,
              ...(onSandboxStatus ? { onStatus: onSandboxStatus } : {}),
            },
          );
          ownerAuthBox.pending = handle;
          ownerAuthBox.provisionMs = Date.now() - provisionStart;
          ownerAuthBox.handle = handle;
          return handle;
        })().catch(async (err) => {
          ownerAuthProvisionInFlight = null;
          if (err instanceof SandboxProvisionCleanupError) ownerAuthBox.pending = err.handle;
          const pendingHandle = ownerAuthBox.pending;
          if (pendingHandle) {
            try {
              await destroyEphemeralHandle(pendingHandle);
              if (ownerAuthBox.pending === pendingHandle) ownerAuthBox.pending = null;
            } catch (cleanupErr) {
              deps.errors?.record(
                {
                  category: "sandbox",
                  code: "owner_auth_init_cleanup_failed",
                  message: errMessage(cleanupErr),
                  scopeLabel: scopeId,
                  sessionId: session.id,
                },
                cleanupErr,
              );
            }
          }
          throw err;
        });
        return ownerAuthProvisionInFlight;
      }
    : undefined;
  const reachBoxes = new Map<ScopeId, SandboxHandle>();
  const provisionForReach = async (target: ScopeId): Promise<SandboxHandle> => {
    const cached = reachBoxes.get(target);
    if (cached) return cached;
    const handle = await deps.sandbox.provision(
      [
        { scopeId: resolution.orgScopeId, mountPath: "global", mode: "ro" },
        { scopeId: target, mountPath: "", mode: "rw" },
      ],
      {
        egress: resolution.egress,
        ...(egressTokenForTurn ? { egressToken: egressTokenForTurn } : {}),
        ...(onSandboxStatus ? { onStatus: onSandboxStatus } : {}),
      },
    );
    reachBoxes.set(target, handle);
    return handle;
  };
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
  const prepareTurnFiles = async (handle: SandboxHandle): Promise<void> => {
    const cutoff = Date.now() - TURN_FILES_MAX_AGE_MS;
    const paths = deps.sandbox.removeDirAndList
      ? await deps.sandbox.removeDirAndList(handle, turnSessionDir, TURN_FILES_DIR)
      : await (async () => {
          await deps.sandbox.removeDir(handle, turnSessionDir);
          return deps.sandbox.listDir(handle, TURN_FILES_DIR);
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
  const hasLiveProcesses = async (handle: SandboxHandle, fallbackScope: ScopeId): Promise<boolean> => {
    if (!deps.processes) return false;
    if (!handle.resourceId) return (await deps.processes.liveByScope(fallbackScope)).length > 0;
    return (await deps.processes.listLive()).some(
      (process) =>
        process.sandboxId === handle.resourceId ||
        (!process.sandboxId && process.scopeId === (handle.scopeId ?? fallbackScope)),
    );
  };
  const reclaimBox = async (): Promise<void> => {
    let ownerCleanupError: unknown;
    let scratchCleanupError: unknown;
    if (ownerAuthProvisionInFlight)
      await ownerAuthProvisionInFlight.catch(swallowAs("orchestrator: owner auth provision", undefined));
    ownerAuthProvisionInFlight = null;
    const reachEntries = [...reachBoxes.entries()];
    reachBoxes.clear();
    await Promise.all(
      reachEntries.map(async ([target, h]) => {
        let keepReachWarm = false;
        if (deps.processes && supportsProcessSessions(deps.sandbox)) {
          try {
            keepReachWarm = await hasLiveProcesses(h, target);
          } catch (e) {
            swallow("orchestrator: reach live process check", e);
            keepReachWarm = false;
          }
        }
        if (keepReachWarm) {
          await deps.sandbox
            .teardown(h, { keepWarm: true })
            .catch(swallowAs("orchestrator: keep warm teardown", undefined));
          return;
        }
        await deps.sandbox.teardown(h).catch(swallowAs("orchestrator: teardown", undefined));
      }),
    );
    const ownerHandle = ownerAuthBox.handle ?? ownerAuthBox.pending;
    if (ownerHandle) {
      try {
        await destroyEphemeralHandle(ownerHandle);
        ownerAuthBox.handle = null;
        ownerAuthBox.pending = null;
      } catch (err) {
        ownerCleanupError = err;
        deps.errors?.record(
          {
            category: "sandbox",
            code: "owner_auth_destroy_failed",
            message: errMessage(err),
            scopeLabel: scopeId,
            sessionId: session.id,
          },
          err,
        );
      }
    }
    if (scratchProvisionInFlight)
      await scratchProvisionInFlight.catch(swallowAs("orchestrator: scratch provision", undefined));
    scratchProvisionInFlight = null;
    const scratchHandle = scratchBox.handle ?? scratchBox.pending;
    if (scratchHandle) {
      const cleanupStart = Date.now();
      try {
        await destroyEphemeralHandle(scratchHandle);
        scratchBox.handle = null;
        scratchBox.pending = null;
        recordScratchLifecycle("released", scratchHandle, {
          releasedAt: Date.now(),
          cleanupMs: Date.now() - cleanupStart,
        });
      } catch (error) {
        scratchCleanupError = error instanceof Error ? error : new Error(errMessage(error));
        recordScratchLifecycle("release_failed", scratchHandle, {
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
          scratchCleanupError,
        );
      }
    }
    await Promise.allSettled(resourcePending.values());
    const released = new Set<string>();
    const current = box.handle ?? box.pending;
    const releases: Promise<void>[] = [];
    for (const handle of [...resourceHandles.values(), ...resourcePendingHandles.values()]) {
      const key = `${handle.backend}:${handle.id}`;
      if (released.has(key) || (current?.id === handle.id && current.backend === handle.backend)) continue;
      released.add(key);
      releases.push(
        (async () => {
          try {
            if (handle.scopeId === undefined || handle.scopeId === writableScopeId || handle.scopeId === scopeId)
              await clearTurnFiles(handle);
          } finally {
            await deps.sandbox.teardown(handle, {
              keepWarm: await hasLiveProcesses(handle, memoryScopeId).catch(
                swallowAs("orchestrator: live process check", true),
              ),
            });
          }
        })(),
      );
    }
    const releasedResults = await Promise.allSettled(releases);
    for (const result of releasedResults)
      if (result.status === "rejected") swallow("resource sandbox release", result.reason);
    resourceHandles.clear();
    resourcePendingHandles.clear();
    if (provisionInFlight) await provisionInFlight.catch(swallowAs("orchestrator: provision", undefined));
    provisionInFlight = null;
    const handle = box.handle ?? box.pending;
    box.handle = null;
    box.pending = null;
    if (!handle) {
      if (ownerCleanupError) throw ownerCleanupError;
      if (scratchCleanupError) throw scratchCleanupError;
      return;
    }
    await clearTurnFiles(handle);
    let keepWarm = false;
    if (deps.processes && supportsProcessSessions(deps.sandbox)) {
      try {
        keepWarm = await hasLiveProcesses(handle, memoryScopeId);
      } catch (e) {
        swallow("orchestrator: live process check", e);
        keepWarm = false;
      }
    }
    await deps.sandbox.teardown(handle, {
      ...(keepWarm ? { keepWarm: true } : {}),
      ...(box.used ? {} : { homeUnchanged: true }),
    });
    if (ownerCleanupError) throw ownerCleanupError;
    if (scratchCleanupError) throw scratchCleanupError;
  };

  return {
    box,
    scratchBox,
    ownerAuthBox,
    ownerAuthCommand,
    scopedCommand,
    provision,
    provisionScratch,
    accessResource,
    provisionResource,
    provisionOwnerAuth,
    useSkill,
    provisionForReach,
    reclaimBox,
    provisionPending: () => provisionInFlight !== null,
    invalidateProvision: () => {
      const previous = box.handle ?? box.pending;
      if (previous)
        (box.handle ? resourceHandles : resourcePendingHandles).set(previous.resourceId ?? previous.id, previous);
      box.handle = null;
      box.pending = null;
      provisionInFlight = null;
      laidTrees.clear();
    },
  };
}
