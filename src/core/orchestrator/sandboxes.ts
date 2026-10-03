import { NonRetryableTurnError } from "../turn-error.ts";
import type { Principal, Resolution, ScopeId, Session, SessionEntry } from "../../types.ts";
import { personalScope } from "../../types.ts";
import { intersectEgressPolicies } from "../../resolution/egress-policy.ts";
import { isOpenScopeMember } from "../../resolution/sharing-access.ts";
import type { GapPhase } from "../../sessions/session-store.ts";
import {
  type Sandbox,
  type SandboxHandle,
  supportsProcessSessions,
  SandboxProvisionCleanupError,
} from "../../sandbox/sandbox.ts";
import type { DurableMap } from "../../persistence/durable-map.ts";
import type { SandboxAccessPlan } from "../../sandbox/sandbox-resources.ts";
import { reconcileProcesses } from "../../processes/reconcile.ts";
import {
  deviceFlowCredOwner,
  materializeDeviceFlowLogins,
  removeDeviceFlowLogins,
} from "../../credentials/device-flow-persist.ts";
import type { DeviceFlowCutoverMode } from "../../credentials/device-flow-cutover.ts";
import { expandServiceAliases } from "../../credentials/resident-paths.ts";
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
import { sleep, withAbort } from "../../util/async.ts";
import { loadActiveBundles } from "./turn-helpers.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";

const TURN_FILES_MAX_AGE_MS = 24 * 60 * 60_000;

export interface PendingSandboxScrub {
  createdAt: number;
  scopeLabel: string;
  boxes: Array<{ layers: Resolution["layers"]; sandboxId?: string; egress?: Resolution["egress"]; dirs: string[] }>;
  pausing?: string;
}

export async function finishPendingScrubs(
  sandbox: Pick<Sandbox, "provision" | "removeDir" | "teardown">,
  scrubs: DurableMap<PendingSandboxScrub>,
): Promise<void> {
  for (const [id, noted] of await scrubs.entries()) {
    if (noted.pausing) continue;
    const pending = await scrubs.take(id);
    if (!pending || Date.now() - pending.createdAt > TURN_FILES_MAX_AGE_MS) continue;
    const remaining: PendingSandboxScrub["boxes"] = [];
    for (const box of pending.boxes) {
      try {
        const handle = await sandbox.provision(box.layers, {
          ...(box.sandboxId ? { sandboxId: box.sandboxId } : {}),
          ...(box.egress ? { egress: box.egress } : {}),
        });
        try {
          await Promise.all(box.dirs.map((dir) => sandbox.removeDir(handle, dir)));
        } finally {
          await sandbox
            .teardown(handle, { keepWarm: true })
            .catch(swallowAs("orchestrator: pending scrub teardown", undefined));
        }
      } catch (err) {
        swallow(`orchestrator: pending sandbox scrub ${id}`, err);
        remaining.push(box);
      }
    }
    if (remaining.length) await scrubs.put(id, { ...pending, boxes: remaining });
  }
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
  turnSessionDir: string;
  turnFilesDir: string;
  connectorEnv: Record<string, string>;
  egressTokenForTurn: string | undefined;
  egressTokenForPolicy?: (policy: Resolution["egress"]) => Promise<string | undefined>;
  isolateOwnerKeychain: boolean;
  openSpeakerKeychain?: boolean;
  openResourceAccess?: boolean;
  ownerAuthAvailable: boolean;
  credentialTools: readonly import("../../deployment/load-layer.ts").LayerCredentialTool[];
  credentialServices: string[];
  credentialCutoverServices: string[];
  quarantinedServices: string[];
  cutoverModeOf: (service: string) => DeviceFlowCutoverMode;
  visibleSkillsForTurn: () => Promise<SkillResolution[]>;
  emitGapWork: (phase: GapPhase, start: number, end: number) => void;
  perf: { credsMs: number };
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
    isolateOwnerKeychain,
    openSpeakerKeychain,
    openResourceAccess,
    ownerAuthAvailable,
    credentialTools,
    credentialServices,
    credentialCutoverServices,
    quarantinedServices,
    cutoverModeOf,
    visibleSkillsForTurn,
    emitGapWork,
    perf,
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
  let closed = false;
  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(promise: Promise<T>): Promise<T> => {
    const guarded = promise.then((value) => {
      if (closed) throw closedError();
      return value;
    });
    inFlight.add(guarded);
    const settle = () => void inFlight.delete(guarded);
    guarded.then(settle, settle);
    return guarded;
  };
  const closedError = () => new Error("This turn's sandboxes have already been released");
  const boxKey = (handle: SandboxHandle) => `${handle.backend}:${handle.id}`;
  const boxSpecs = new Map<string, Omit<PendingSandboxScrub["boxes"][number], "dirs">>();
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
  const scrubOwnerAuthHandle = async (handle: SandboxHandle): Promise<void> => {
    if (!deps.keychain || !isolateOwnerKeychain) return;
    const services = (await deps.keychain.listByOwner(actor.id))
      .filter((record) => record.kind === "file")
      .map((record) => record.service);
    if (!services.length) return;
    await removeDeviceFlowLogins({
      sandbox: deps.sandbox,
      handle,
      keychain: deps.keychain,
      ownerId: actor.id,
      services,
      allOrigins: true,
      canonicalRoots: credentialTools.filter((tool) => services.includes(tool.service)).flatMap((tool) => tool.roots),
    });
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
    if (closed) return Promise.reject(closedError());
    if (!eager) box.used = true;
    provisionInFlight ??= track(
      doProvision(eager ? () => {} : emitGapWork, eager).catch((err) => {
        provisionInFlight = null;
        throw err;
      }),
    );
    return provisionInFlight;
  };
  const prepareCredentials = async (
    handle: SandboxHandle,
    emit: typeof emitGapWork,
    credentialScopeId = memoryScopeId,
  ): Promise<void> => {
    if (!input.externalSlack && deps.keychain) {
      const deviceFlowStart = Date.now();
      const crossScope = credentialScopeId !== memoryScopeId;
      const services = crossScope
        ? [
            ...new Set([
              ...credentialServices,
              ...((await deps.deviceFlowCutover?.listServices(credentialScopeId)) ?? []),
            ]),
          ]
        : credentialServices;
      const targetModes = new Map<string, DeviceFlowCutoverMode>();
      if (crossScope) {
        for (const service of services) {
          const policy = await deps.deviceFlowCutover?.resolvePolicy(credentialScopeId, service);
          targetModes.set(service, policy?.mode ?? "legacy");
        }
      }
      const modeOf = (service: string): DeviceFlowCutoverMode => targetModes.get(service) ?? cutoverModeOf(service);
      const excludedServices = [
        ...new Set([...quarantinedServices, ...services.filter((service) => modeOf(service) === "ephemeral_only")]),
      ];
      const restoreOwnerId =
        !crossScope && input.origin.kind === "automation" && input.origin.useOwnerKeychain && !isolateOwnerKeychain
          ? actor.id
          : deviceFlowCredOwner(credentialScopeId, actor.id);
      const resetGenerations = new Map<string, string>();
      for (const service of services) {
        if (modeOf(service) !== "legacy") continue;
        const generation = await deps.deviceFlowCutover?.residentResetGeneration(
          credentialScopeId,
          service,
          handle.resourceId,
        );
        if (generation) resetGenerations.set(service, generation);
      }
      const owned = resetGenerations.size ? await deps.keychain.listByOwner(restoreOwnerId) : [];
      const resetServices = [...resetGenerations.keys()].filter((service) =>
        owned.some((record) => expandServiceAliases([service]).includes(record.service)),
      );
      const removeServices = [...new Set([...excludedServices, ...resetServices])];
      if (removeServices.length) {
        await removeDeviceFlowLogins({
          sandbox: deps.sandbox,
          handle,
          keychain: deps.keychain,
          ownerId: restoreOwnerId,
          ...(crossScope ? { allOrigins: true } : {}),
          services: removeServices,
          canonicalRoots: credentialTools
            .filter((tool) => removeServices.includes(tool.service))
            .flatMap((tool) => tool.roots),
        });
      }
      try {
        const restoredServices = await materializeDeviceFlowLogins({
          sandbox: deps.sandbox,
          handle,
          keychain: deps.keychain,
          ownerId: restoreOwnerId,
          ...(crossScope ? { allOrigins: true } : {}),
          ...(excludedServices.length ? { excludeServices: excludedServices } : {}),
          onAnomaly: (service, detail) =>
            deps.errors?.record({
              category: "keychain",
              code: "device_flow_restore_failed",
              message: `${service}: ${detail}`,
              scopeLabel: scopeId,
              sessionId: session.id,
            }),
        });
        for (const service of restoredServices) {
          deps.credentialUsage?.record({
            slug: `keychain:${service}`,
            host: "local",
            status: modeOf(service) === "prefer_ephemeral" ? "legacy_retained" : "legacy_restored",
            scopeLabel: scopeId,
            principalId: actor.id,
          });
        }
        for (const [service, generation] of resetGenerations) {
          await deps.deviceFlowCutover?.markResidentReset(credentialScopeId, service, generation, handle.resourceId);
        }
      } catch (err) {
        deps.errors?.record(
          {
            category: "keychain",
            code: "device_flow_restore_failed",
            message: errMessage(err),
            scopeLabel: scopeId,
            sessionId: session.id,
          },
          err,
        );
      }
      emit("creds", deviceFlowStart, Date.now());
      perf.credsMs += Date.now() - deviceFlowStart;
    }
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
    boxSpecs.set(boxKey(handle), {
      layers: resolution.layers,
      ...(handle.resourceId ? { sandboxId: handle.resourceId } : {}),
      egress: resolution.egress,
    });
    if (closed) throw closedError();
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
    await prepareCredentials(handle, emit);
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
  const restoredDirs = new Map<string, Set<string>>();
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
  const restoreSkillFiles = async (entries: readonly SessionEntry[]): Promise<void> => {
    const visible = await visibleSkillsForTurn();
    for (const entry of entries) {
      if (entry.type !== "tool_result") continue;
      const payload = entry.payload as {
        tool?: string;
        name?: string;
        dir?: string;
        sandboxId?: string;
        isError?: boolean;
      } | null;
      if ((payload?.tool !== "skill" && payload?.tool !== "skills") || !payload.dir || payload.isError) continue;
      const prefix = `${turnSessionDir}/`;
      const relative = payload.dir.startsWith(prefix) ? payload.dir.slice(prefix.length).split("/") : [];
      if (
        relative.length !== 3 ||
        !/^[a-z0-9]+-[a-f0-9]{24}$/.test(relative[0]!) ||
        relative[1] !== SKILLS_DIR ||
        relative[2] !== payload.name ||
        !isSafeSkillName(relative[2]!)
      )
        throw new NonRetryableTurnError("Cannot restore skill files outside this turn's directory");
      const resolution = visible.find((r) => r.skill?.manifest.name === payload.name);
      if (!resolution?.skill) throw new NonRetryableTurnError(`Cannot restore unavailable skill ${payload.name}`);
      const bundles =
        resolution.screenedBundles ??
        (deps.skillBundles ? await loadActiveBundles(deps.skillBundles, [resolution]) : []);
      const access = payload.sandboxId ? await accessResource(payload.sandboxId) : undefined;
      if (access?.crossScope) throw new NonRetryableTurnError("Cannot restore skill files on a cross-scope sandbox");
      const handle = access ? await provisionResource(access) : await provision();
      const root = `${prefix}${relative[0]}/${SKILLS_DIR}`;
      const key = `${handle.backend}:${handle.id}`;
      const dirs = restoredDirs.get(key) ?? new Set<string>();
      dirs.add(`${prefix}${relative[0]}`);
      restoredDirs.set(key, dirs);
      await laySkillTree(deps.sandbox, handle, root, resolution, bundles);
    }
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
    if (closed) throw closedError();
    const access = typeof input === "string" ? await accessResource(input) : input;
    const { resource, crossScope, egress, credentialScopeId } = access;
    const id = resource.id;
    const pending = resourcePending.get(id);
    if (pending) {
      await pending;
      return provisionResource(id, authorize);
    }
    authorize?.(access);
    if (closed) throw closedError();
    const policyKey = JSON.stringify({ egress, credentialScopeId });
    const existing = resourceHandles.get(id);
    if (existing && resourcePolicy.get(id) === policyKey) {
      if (credentialScopeId) await prepareCredentials(existing, emitGapWork, credentialScopeId);
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
      boxSpecs.set(boxKey(handle), { layers, sandboxId: id, egress });
      if (closed) throw closedError();
      if (credentialScopeId) await prepareCredentials(handle, emitGapWork, credentialScopeId);
      if (!crossScope) {
        await prepareCredentials(handle, emitGapWork);
        await prepareTurnFiles(handle);
      }
      resourceHandles.set(id, handle);
      resourcePolicy.set(id, policyKey);
      resourcePendingHandles.delete(id);
      return handle;
    })().finally(() => {
      resourcePending.delete(id);
    });
    const tracked = track(provisioned);
    resourcePending.set(id, tracked);
    return tracked;
  };

  const provisionScratch = (): Promise<SandboxHandle> => {
    if (closed) return Promise.reject(closedError());
    if (scratchBox.pending)
      return Promise.reject(new Error("Disposable sandbox initialization cleanup is still pending"));
    if (scratchBox.handle) return Promise.resolve(scratchBox.handle);
    scratchProvisionInFlight ??= track(
      (async () => {
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
      }),
    );
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
        if (closed) throw closedError();
        if (ownerAuthBox.handle) return ownerAuthBox.handle;
        if (ownerAuthBox.pending && !ownerAuthProvisionInFlight) {
          return Promise.reject(new Error("owner-auth box initialization failed and cleanup is still pending"));
        }
        ownerAuthProvisionInFlight ??= track(
          (async () => {
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
            if (closed) throw closedError();
            if (deps.keychain && isolateOwnerKeychain) {
              const restoredServices = await materializeDeviceFlowLogins({
                sandbox: deps.sandbox,
                handle,
                keychain: deps.keychain,
                ownerId: actor.id,
                ...(openSpeakerKeychain ? { allOrigins: true } : {}),
                ...(credentialCutoverServices.length ? { excludeServices: credentialCutoverServices } : {}),
                onAnomaly: (service, detail) =>
                  deps.errors?.record({
                    category: "keychain",
                    code: "device_flow_restore_failed",
                    message: `${service} (owner-auth box): ${detail}`,
                    scopeLabel: scopeId,
                    sessionId: session.id,
                  }),
              });
              for (const service of restoredServices) {
                deps.auditLog.record({
                  at: Date.now(),
                  principalId: actor.id,
                  action: "keychain.materialize",
                  resource: `${service} (owner-auth box)`,
                  scopeLabel: scopeId,
                });
              }
            }
            ownerAuthBox.handle = handle;
            return handle;
          })().catch(async (err) => {
            ownerAuthProvisionInFlight = null;
            if (err instanceof SandboxProvisionCleanupError) ownerAuthBox.pending = err.handle;
            const pendingHandle = ownerAuthBox.pending;
            if (pendingHandle) {
              try {
                await scrubOwnerAuthHandle(pendingHandle).catch((scrubErr) => {
                  deps.errors?.record(
                    {
                      category: "sandbox",
                      code: "owner_auth_scrub_failed",
                      message: errMessage(scrubErr),
                      scopeLabel: scopeId,
                      sessionId: session.id,
                    },
                    scrubErr,
                  );
                });
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
          }),
        );
        return ownerAuthProvisionInFlight;
      }
    : undefined;
  const reachBoxes = new Map<ScopeId, SandboxHandle>();
  const provisionForReach = async (target: ScopeId): Promise<SandboxHandle> => {
    if (closed) throw closedError();
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
    if (closed) {
      await deps.sandbox.teardown(handle).catch(swallowAs("orchestrator: late reach teardown", undefined));
      throw closedError();
    }
    reachBoxes.set(target, handle);
    return handle;
  };
  const turnDirsOf = (handle: SandboxHandle) => [turnFilesDir, ...(restoredDirs.get(boxKey(handle)) ?? [])];
  const clearTurnFiles = async (handle: SandboxHandle): Promise<boolean> => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await Promise.all(turnDirsOf(handle).map((dir) => deps.sandbox.removeDir(handle, dir)));
        return true;
      } catch (err) {
        if (attempt === 3) swallow("orchestrator: turn file cleanup", err);
        else await sleep(50);
      }
    }
    return false;
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
  const reclaimBox = async (deadline?: AbortSignal): Promise<void> => {
    const startedAt = Date.now();
    let steps = 0;
    const deferred: string[] = [];
    const timed = async <T>(step: string, handle: SandboxHandle | undefined, work: () => Promise<T>): Promise<T> => {
      const at = Date.now();
      let ok = false;
      try {
        const value = await work();
        ok = true;
        return value;
      } finally {
        steps++;
        console.error(
          `[sandbox.cleanup] step=${step} backend=${handle?.backend ?? "unknown"} ms=${Date.now() - at} ok=${ok}`,
        );
      }
    };
    const audit = (scrubPending: boolean) =>
      (steps || deferred.length) &&
      deps.auditLog?.record({
        at: Date.now(),
        principalId: actor.id,
        action: "sandbox.cleanup",
        resource: scratchKey(),
        scopeLabel: scopeId,
        detail: JSON.stringify({
          runId: input.runId,
          sessionId: session.id,
          totalMs: Date.now() - startedAt,
          deferred,
          ...(scrubPending ? { scrubPending } : {}),
        }),
      });
    const { scrubbed, finished } = reclaimSteps(timed, deferred, deadline);
    let scrubDone = false;
    void scrubbed.then(() => (scrubDone = true));
    if (
      await withAbort(() => finished, deadline).then(
        () => false,
        () => true,
      )
    ) {
      const pending = !scrubDone;
      void finished.then(() => audit(pending));
      if (pending) {
        await noteScrubPending();
        void scrubbed.then(noteScrubPending);
      }
      return;
    }
    audit(unscrubbed.size > 0);
    if (unscrubbed.size) await noteScrubPending();
    for (const result of await finished) if (result?.status === "rejected") throw result.reason;
  };
  const releaseOwnerAuth = async (): Promise<void> => {
    const handle = ownerAuthBox.handle ?? ownerAuthBox.pending;
    if (!handle) return;
    try {
      await scrubOwnerAuthHandle(handle).catch((scrubErr) => {
        deps.errors?.record(
          {
            category: "sandbox",
            code: "owner_auth_scrub_failed",
            message: errMessage(scrubErr),
            scopeLabel: scopeId,
            sessionId: session.id,
          },
          scrubErr,
        );
      });
      await destroyEphemeralHandle(handle);
      ownerAuthBox.handle = null;
      ownerAuthBox.pending = null;
    } catch (err) {
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
      throw err;
    }
  };
  const releaseScratch = async (): Promise<void> => {
    const handle = scratchBox.handle ?? scratchBox.pending;
    if (!handle) return;
    const cleanupStart = Date.now();
    try {
      await destroyEphemeralHandle(handle);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(errMessage(cause));
      recordScratchLifecycle("release_failed", handle, {
        releasedAt: Date.now(),
        cleanupMs: Date.now() - cleanupStart,
        error: errMessage(cause),
      });
      deps.errors?.record(
        {
          category: "sandbox",
          code: "scratch_destroy_failed",
          message: errMessage(cause),
          scopeLabel: scopeId,
          sessionId: session.id,
        },
        error,
      );
      throw error;
    }
    scratchBox.handle = null;
    scratchBox.pending = null;
    recordScratchLifecycle("released", handle, { releasedAt: Date.now(), cleanupMs: Date.now() - cleanupStart });
  };
  const liveProcessesOn = async (handle: SandboxHandle, fallbackScope: ScopeId, label: string): Promise<boolean> => {
    if (!deps.processes || !supportsProcessSessions(deps.sandbox)) return false;
    return hasLiveProcesses(handle, fallbackScope).catch((e) => {
      swallow(label, e);
      return false;
    });
  };
  const scrubResource = async (handle: SandboxHandle): Promise<boolean> =>
    !(handle.scopeId === undefined || handle.scopeId === writableScopeId || handle.scopeId === scopeId) ||
    clearTurnFiles(handle);
  const teardownResource = async (handle: SandboxHandle, warm: boolean): Promise<void> => {
    const keepWarm = warm || (await hasLiveProcesses(handle, memoryScopeId).catch(() => true));
    await deps.sandbox.teardown(handle, { keepWarm });
  };
  const teardownMain = async (handle: SandboxHandle, used: boolean, warm: boolean): Promise<void> => {
    const keepWarm = warm || (await liveProcessesOn(handle, memoryScopeId, "orchestrator: live process check"));
    await deps.sandbox.teardown(handle, {
      ...(keepWarm ? { keepWarm: true } : {}),
      ...(used ? {} : { homeUnchanged: true }),
    });
  };
  const released = new Set<string>();
  const claim = (handle: SandboxHandle): boolean => {
    const key = boxKey(handle);
    if (released.has(key)) return false;
    released.add(key);
    return true;
  };
  const unscrubbed = new Set<SandboxHandle>();
  let noted = false;
  const scrubLate = async (handle: SandboxHandle, work: () => Promise<boolean>): Promise<void> => {
    unscrubbed.add(handle);
    const done = await work();
    if (done) unscrubbed.delete(handle);
    if (!done || noted) await noteScrubPending();
  };
  const reclaimSteps = (
    timed: <T>(step: string, handle: SandboxHandle | undefined, work: () => Promise<T>) => Promise<T>,
    deferred: string[],
    deadline: AbortSignal | undefined,
  ) => {
    closed = true;
    const later = (step: string, promise: Promise<unknown> | null, release: () => Promise<unknown>): boolean => {
      if (!promise || !inFlight.has(promise)) return false;
      deferred.push(step);
      void promise.then(release, release).catch(swallowAs(`orchestrator: late ${step} release`, undefined));
      return true;
    };
    const takeMain = () => {
      const handle = box.handle ?? box.pending;
      box.handle = null;
      box.pending = null;
      return handle && claim(handle) ? handle : null;
    };
    const mainLate = later("provision", provisionInFlight, async () => {
      const handle = takeMain();
      if (!handle) return;
      await scrubLate(handle, () => clearTurnFiles(handle));
      await teardownMain(handle, box.used, true);
    });
    const ownerLate = later("owner_auth", ownerAuthProvisionInFlight, releaseOwnerAuth);
    const scratchLate = later("scratch", scratchProvisionInFlight, releaseScratch);
    const lateResources = [...resourcePending].filter(([id, promise]) =>
      later("resource", promise, async () => {
        const handle = resourceHandles.get(id) ?? resourcePendingHandles.get(id);
        resourceHandles.delete(id);
        resourcePendingHandles.delete(id);
        if (!handle || !claim(handle)) return;
        await scrubLate(handle, () => scrubResource(handle));
        await teardownResource(handle, true);
      }),
    );
    ownerAuthProvisionInFlight = null;
    scratchProvisionInFlight = null;
    provisionInFlight = null;
    const reachEntries = [...reachBoxes.entries()];
    reachBoxes.clear();
    const main = mainLate ? null : takeMain();
    const used = box.used;
    const resources: SandboxHandle[] = [];
    for (const [id, handle] of [...resourceHandles, ...resourcePendingHandles]) {
      if (lateResources.some(([late]) => late === id)) continue;
      resourceHandles.delete(id);
      resourcePendingHandles.delete(id);
      if (claim(handle)) resources.push(handle);
    }
    const ownerHandle = ownerLate ? null : (ownerAuthBox.handle ?? ownerAuthBox.pending);
    const scratchHandle = scratchLate ? null : (scratchBox.handle ?? scratchBox.pending);
    for (const handle of [...resources, ...(main ? [main] : [])]) unscrubbed.add(handle);
    const scrub = (step: string, handle: SandboxHandle, work: () => Promise<boolean>) =>
      timed(step, handle, work).then((done) => void (done && unscrubbed.delete(handle)));
    const scrubbed = Promise.allSettled([
      ownerHandle && timed("owner_auth_scrub", ownerHandle, releaseOwnerAuth),
      scratchHandle && timed("scratch_destroy", scratchHandle, releaseScratch),
      ...resources.map((handle) => scrub("resource_scrub", handle, () => scrubResource(handle))),
      main && scrub("scrub", main, () => clearTurnFiles(main)),
    ]);
    const finished = scrubbed.then(async ([owner, scratch]) => {
      const warm = !!deadline?.aborted;
      const [mainTeardown, ...rest] = await Promise.allSettled([
        main && timed("teardown", main, () => teardownMain(main, used, warm)),
        ...resources.map((handle) => timed("resource_teardown", handle, () => teardownResource(handle, warm))),
        ...reachEntries.map(async ([target, handle]) => {
          const keepWarm = warm || (await liveProcessesOn(handle, target, "orchestrator: reach live process check"));
          await timed("reach_teardown", handle, () =>
            deps.sandbox.teardown(handle, keepWarm ? { keepWarm: true } : undefined),
          ).catch(swallowAs("orchestrator: reach teardown", undefined));
        }),
      ]);
      for (const result of rest) if (result.status === "rejected") swallow("resource sandbox release", result.reason);
      return [mainTeardown, owner, scratch];
    });
    return { scrubbed, finished };
  };
  const noteScrubPending = async (): Promise<void> => {
    if (!deps.sandboxScrubs) return;
    const id = `${session.id}:${transferId}`;
    const current = box.handle ?? box.pending;
    const handles = new Set([...unscrubbed, ...(current ? [current] : []), ...resourcePendingHandles.values()]);
    noted = handles.size > 0;
    const boxes = [...handles].map((handle) => ({
      ...(boxSpecs.get(boxKey(handle)) ?? { layers: resolution.layers }),
      dirs: turnDirsOf(handle),
    }));
    await (
      boxes.length
        ? deps.sandboxScrubs.put(id, { createdAt: Date.now(), scopeLabel: scopeId, boxes })
        : deps.sandboxScrubs.delete(id)
    ).catch(swallowAs("orchestrator: pending sandbox scrub note", undefined));
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
    restoreSkillFiles,
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
