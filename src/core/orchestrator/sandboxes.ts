import type { Principal, Resolution, ScopeId, Session } from "../../types.ts";
import type { GapPhase } from "../../sessions/session-store.ts";
import { type SandboxHandle, supportsProcessSessions } from "../../sandbox/sandbox.ts";
import { reconcileProcesses } from "../../processes/reconcile.ts";
import {
  deviceFlowCredOwner,
  materializeDeviceFlowLogins,
  removeDeviceFlowLogins,
} from "../../credentials/device-flow-persist.ts";
import type { DeviceFlowCutoverMode } from "../../credentials/device-flow-cutover.ts";
import {
  probeResidentAuth,
  residentAuthProbeIsStale,
  type ResidentAuthConnector,
} from "../../credentials/resident-auth.ts";
import { expandServiceAliases } from "../../credentials/resident-paths.ts";
import { shq } from "../../util/shell.ts";
import { createSkillMaterializer, safeSkillDirName } from "../../skills/materialize.ts";
import type { SkillResolution } from "../../skills/skill-store.ts";
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
  isolateOwnerKeychain: boolean;
  ownerAuthAvailable: boolean;
  ownerAuthEnv: Record<string, string>;
  ownerEnvCredentialIds: string[];
  credentialTools: readonly import("../../deployment/load-layer.ts").LayerCredentialTool[];
  credentialServices: string[];
  credentialCutoverServices: string[];
  quarantinedServices: string[];
  cutoverModeOf: (service: string) => DeviceFlowCutoverMode;
  visibleSkills: SkillResolution[];
  visibleSkillsForTurn: () => Promise<SkillResolution[]>;
  skillMaterializer: ReturnType<typeof createSkillMaterializer>;
  residentAuthConnectors: () => ResidentAuthConnector[];
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
    isolateOwnerKeychain,
    ownerAuthAvailable,
    ownerAuthEnv,
    ownerEnvCredentialIds,
    credentialTools,
    credentialServices,
    credentialCutoverServices,
    quarantinedServices,
    cutoverModeOf,
    visibleSkills,
    visibleSkillsForTurn,
    skillMaterializer,
    residentAuthConnectors,
    emitGapWork,
    perf,
  } = ctx;

  let ownerAuthCommand: ((command: string) => string) | undefined;
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
    ? (command: string): string => `${unsetBrokerEnv(connectorEnv)}${command}`
    : undefined;
  if (ownerAuthAvailable) {
    ownerAuthCommand = (command) => {
      for (const credentialId of ownerEnvCredentialIds) {
        deps.auditLog.record({
          at: Date.now(),
          principalId: actor.id,
          action: "keychain.materialize",
          resource: `${credentialId} (owner-auth command)`,
          scopeLabel: scopeId,
        });
      }
      const exports = Object.entries(ownerAuthEnv)
        .map(([key, value]) => `${key}=${shq(value)}`)
        .join(" ");
      return `unset AGENT_API_TOKEN AGENT_OAUTH_CONSENT_TOKEN AGENT_CREDENTIAL_TOKEN; ${unsetBrokerEnv(ownerAuthEnv)}${exports ? `export ${exports}; ` : ""}${command}`;
    };
  }
  const box: {
    handle: SandboxHandle | null;
    pending: SandboxHandle | null;
    used: boolean;
    provisionMs?: number;
    materializeMs?: number;
    residentAuthProbe?: Promise<void>;
  } = { handle: null, pending: null, used: false };
  const scratchBox: { handle: SandboxHandle | null; provisionMs?: number } = { handle: null };
  const ownerAuthBox: { handle: SandboxHandle | null; pending: SandboxHandle | null; provisionMs?: number } = {
    handle: null,
    pending: null,
  };
  let ownerAuthProvisionInFlight: Promise<SandboxHandle> | null = null;
  const destroyOwnerAuthHandle = async (handle: SandboxHandle): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await deps.sandbox.teardown(handle, { destroy: true });
        return;
      } catch (err) {
        lastError = err;
        if (attempt < 3) await sleep(50 * attempt);
      }
    }
    throw lastError;
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
  const resourcePendingHandles = new Map<string, SandboxHandle>();
  const resourcePending = new Map<string, Promise<SandboxHandle>>();
  let provisionInFlight: Promise<SandboxHandle> | null = null;
  const provision = (eager = false): Promise<SandboxHandle> => {
    if (!eager) box.used = true;
    provisionInFlight ??= doProvision(eager ? () => {} : emitGapWork).catch((err) => {
      provisionInFlight = null;
      throw err;
    });
    return provisionInFlight;
  };
  const prepareCredentials = async (handle: SandboxHandle, emit: typeof emitGapWork): Promise<void> => {
    if (deps.keychain) {
      const deviceFlowStart = Date.now();
      const restoreOwnerId =
        input.origin.kind === "automation" && input.origin.useOwnerKeychain && !isolateOwnerKeychain
          ? actor.id
          : deviceFlowCredOwner(memoryScopeId, actor.id);
      const resetGenerations = new Map<string, string>();
      for (const service of credentialServices) {
        if (cutoverModeOf(service) !== "legacy") continue;
        const generation = await deps.deviceFlowCutover?.residentResetGeneration(
          memoryScopeId,
          service,
          handle.resourceId,
        );
        if (generation) resetGenerations.set(service, generation);
      }
      const owned = resetGenerations.size ? await deps.keychain.listByOwner(restoreOwnerId) : [];
      const resetServices = [...resetGenerations.keys()].filter((service) =>
        owned.some((record) => expandServiceAliases([service]).includes(record.service)),
      );
      const removeServices = [...new Set([...quarantinedServices, ...resetServices])];
      if (removeServices.length) {
        await removeDeviceFlowLogins({
          sandbox: deps.sandbox,
          handle,
          keychain: deps.keychain,
          ownerId: restoreOwnerId,
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
          ...(quarantinedServices.length ? { excludeServices: quarantinedServices } : {}),
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
            status: cutoverModeOf(service) === "prefer_ephemeral" ? "legacy_retained" : "legacy_restored",
            scopeLabel: scopeId,
            principalId: actor.id,
          });
        }
        for (const [service, generation] of resetGenerations) {
          await deps.deviceFlowCutover?.markResidentReset(memoryScopeId, service, generation, handle.resourceId);
        }
      } catch (err) {
        deps.errors?.record({
          category: "keychain",
          code: "device_flow_restore_failed",
          message: errMessage(err),
          scopeLabel: scopeId,
          sessionId: session.id,
        });
      }
      emit("creds", deviceFlowStart, Date.now());
      perf.credsMs += Date.now() - deviceFlowStart;
    }
  };
  const doProvision = async (emit: typeof emitGapWork): Promise<SandboxHandle> => {
    const provisionStart = Date.now();
    const handle = await deps.sandbox.provision(resolution.layers, {
      env: connectorEnv,
      egress: resolution.egress,
      ...(egressTokenForTurn ? { egressToken: egressTokenForTurn } : {}),
      ...(onSandboxStatus ? { onStatus: onSandboxStatus } : {}),
    });
    box.pending = handle;
    emit("provision", provisionStart, Date.now());
    box.provisionMs = Date.now() - provisionStart;
    await prepareCredentials(handle, emit);
    const dirCleanupStart = Date.now();
    await deps.sandbox.removeDir(handle, turnSessionDir);
    await sweepStaleTurnFiles(handle);
    emit("dir_cleanup", dirCleanupStart, Date.now());
    if (deps.processes && supportsProcessSessions(deps.sandbox)) {
      const procReconcileStart = Date.now();
      try {
        await reconcileProcesses(deps.sandbox, handle, deps.processes, memoryScopeId);
      } catch (err) {
        deps.errors?.record({
          category: "process_session",
          code: "reconcile_failed",
          message: errMessage(err),
          scopeLabel: scopeId,
          sessionId: session.id,
        });
      } finally {
        emit("proc_reconcile", procReconcileStart, Date.now());
      }
    }
    if (deps.livenessCache) {
      const cache = deps.livenessCache;
      box.residentAuthProbe = (async () => {
        try {
          const cached = await cache.get(memoryScopeId);
          if (residentAuthProbeIsStale(cached, Date.now())) {
            await probeResidentAuth({
              sandbox: deps.sandbox,
              handle,
              cache,
              scopeId: memoryScopeId,
              now: Date.now(),
              connectors: residentAuthConnectors(),
            });
          }
        } catch (err) {
          deps.errors?.record({
            category: "agent_computer",
            code: "resident_auth_probe_failed",
            message: errMessage(err),
            scopeLabel: scopeId,
            sessionId: session.id,
          });
        }
      })();
    }
    if (deps.skills) {
      const materializeStart = Date.now();
      try {
        await skillMaterializer.materializeIndex(deps.sandbox, handle, visibleSkills, visibleSkillsForTurn);
      } finally {
        emit("skills_materialize", materializeStart, Date.now());
        box.materializeMs = Date.now() - materializeStart;
      }
    }
    box.handle = handle;
    return handle;
  };
  const laidTrees = new Set<string>();
  const visibleSkillByDir = new Map<string, SkillResolution>();
  for (const r of visibleSkills) {
    if (r.skill) visibleSkillByDir.set(safeSkillDirName(r.skill.manifest.name), r);
  }
  const ensureSkillTree = async (skillDir: string, sandboxId?: string): Promise<void> => {
    const treeKey = `${sandboxId ?? "default"}:${skillDir}`;
    if (laidTrees.has(treeKey)) return;
    const r = visibleSkillByDir.get(skillDir);
    if (!r) return;
    const start = Date.now();
    try {
      const handle = sandboxId ? await provisionResource(sandboxId) : await provision();
      await skillMaterializer.materializeTree(deps.sandbox, handle, r, [], async () => {
        const latest = (await visibleSkillsForTurn()).find(
          (candidate) => candidate.skill && safeSkillDirName(candidate.skill.manifest.name) === skillDir,
        );
        if (!latest) return null;
        const bundles =
          latest.screenedBundles ?? (deps.skillBundles ? await loadActiveBundles(deps.skillBundles, [latest]) : []);
        return { resolution: latest, bundles };
      });
      laidTrees.add(treeKey);
      if (r.skill && deps.skills)
        void deps.skills.recordUse(r.skill.id).catch((e) => swallow("orchestrator: skill recordUse", e));
    } catch (err) {
      deps.errors?.record({
        category: "skills",
        code: "tree_materialize_failed",
        message: errMessage(err),
        scopeLabel: scopeId,
        sessionId: session.id,
      });
    } finally {
      emitGapWork("skills_materialize", start, Date.now());
    }
  };
  const provisionResource = (id: string): Promise<SandboxHandle> => {
    const existing = resourceHandles.get(id);
    if (existing) return Promise.resolve(existing);
    const pending = resourcePending.get(id);
    if (pending) return pending;
    const provisioned = (async () => {
      const resource = await deps.sandboxResources?.get(id);
      const ownerScope = resolution.layers.find((layer) => layer.mode === "rw")?.scopeId;
      if (!resource || resource.ownerScopeId !== ownerScope)
        throw new Error("sandbox does not belong to this conversation's writable scope");
      const handle = await deps.sandbox.provision(resolution.layers, {
        sandboxId: id,
        env: connectorEnv,
        egress: resolution.egress,
        ...(egressTokenForTurn ? { egressToken: egressTokenForTurn } : {}),
      });
      resourcePendingHandles.set(id, handle);
      await prepareCredentials(handle, emitGapWork);
      await deps.sandbox.removeDir(handle, turnSessionDir);
      await sweepStaleTurnFiles(handle);
      if (deps.skills)
        await skillMaterializer.materializeIndex(deps.sandbox, handle, visibleSkills, visibleSkillsForTurn);
      resourceHandles.set(id, handle);
      resourcePendingHandles.delete(id);
      return handle;
    })().finally(() => {
      resourcePending.delete(id);
    });
    resourcePending.set(id, provisioned);
    return provisioned;
  };

  const provisionScratch = async (): Promise<SandboxHandle> => {
    if (scratchBox.handle) return scratchBox.handle;
    const provisionStart = Date.now();
    const handle = await deps.sandbox.provision(
      resolution.layers.filter((l) => l.mode === "ro" && l.mountPath === "global"),
      {
        egress: resolution.egress,
        ...(egressTokenForTurn ? { egressToken: egressTokenForTurn } : {}),
        scratch: { key: memoryScopeId },
        routeScopeId: memoryScopeId,
        ...(onSandboxStatus ? { onStatus: onSandboxStatus } : {}),
      },
    );
    scratchBox.provisionMs = Date.now() - provisionStart;
    scratchBox.handle = handle;
    return handle;
  };
  const provisionOwnerAuth = ownerAuthAvailable
    ? (): Promise<SandboxHandle> => {
        if (ownerAuthBox.handle) return Promise.resolve(ownerAuthBox.handle);
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
          if (deps.keychain && isolateOwnerKeychain) {
            const restoredServices = await materializeDeviceFlowLogins({
              sandbox: deps.sandbox,
              handle,
              keychain: deps.keychain,
              ownerId: actor.id,
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
          const pendingHandle = ownerAuthBox.pending;
          if (pendingHandle) {
            try {
              await scrubOwnerAuthHandle(pendingHandle).catch((scrubErr) => {
                deps.errors?.record({
                  category: "sandbox",
                  code: "owner_auth_scrub_failed",
                  message: errMessage(scrubErr),
                  scopeLabel: scopeId,
                  sessionId: session.id,
                });
              });
              await destroyOwnerAuthHandle(pendingHandle);
              if (ownerAuthBox.pending === pendingHandle) ownerAuthBox.pending = null;
            } catch (cleanupErr) {
              deps.errors?.record({
                category: "sandbox",
                code: "owner_auth_init_cleanup_failed",
                message: errMessage(cleanupErr),
                scopeLabel: scopeId,
                sessionId: session.id,
              });
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
  const sweepStaleTurnFiles = async (handle: SandboxHandle): Promise<void> => {
    const cutoff = Date.now() - TURN_FILES_MAX_AGE_MS;
    const stale = new Set<string>();
    for (const path of await deps.sandbox.listDir(handle, TURN_FILES_DIR)) {
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
  const reclaimBox = async (): Promise<void> => {
    let ownerCleanupError: unknown;
    if (ownerAuthProvisionInFlight) await ownerAuthProvisionInFlight.catch(() => {});
    ownerAuthProvisionInFlight = null;
    const reachEntries = [...reachBoxes.entries()];
    reachBoxes.clear();
    await Promise.all(
      reachEntries.map(async ([target, h]) => {
        let keepReachWarm = false;
        if (deps.processes && supportsProcessSessions(deps.sandbox)) {
          try {
            keepReachWarm = (await deps.processes.liveByScope(target)).length > 0;
          } catch (e) {
            swallow("orchestrator: reach live process check", e);
            keepReachWarm = false;
          }
        }
        if (keepReachWarm) {
          await deps.sandbox.teardown(h, { keepWarm: true }).catch(() => {});
          return;
        }
        const roomHasComputer = !!(await deps.livenessCache
          ?.get(target)
          .catch(swallowAs("orchestrator: reach computer check", null)));
        await deps.sandbox.teardown(h, roomHasComputer ? undefined : { destroy: true }).catch(() => {});
      }),
    );
    const ownerHandle = ownerAuthBox.handle ?? ownerAuthBox.pending;
    if (ownerHandle) {
      try {
        await scrubOwnerAuthHandle(ownerHandle).catch((scrubErr) => {
          deps.errors?.record({
            category: "sandbox",
            code: "owner_auth_scrub_failed",
            message: errMessage(scrubErr),
            scopeLabel: scopeId,
            sessionId: session.id,
          });
        });
        await destroyOwnerAuthHandle(ownerHandle);
        ownerAuthBox.handle = null;
        ownerAuthBox.pending = null;
      } catch (err) {
        ownerCleanupError = err;
        deps.errors?.record({
          category: "sandbox",
          code: "owner_auth_destroy_failed",
          message: errMessage(err),
          scopeLabel: scopeId,
          sessionId: session.id,
        });
      }
    }
    const scratchHandle = scratchBox.handle;
    scratchBox.handle = null;
    if (scratchHandle) {
      await clearTurnFiles(scratchHandle);
      await deps.sandbox.teardown(scratchHandle).catch(() => {});
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
            await clearTurnFiles(handle);
          } finally {
            const live = await deps.processes?.liveByScope(memoryScopeId).catch(() => []);
            await deps.sandbox.teardown(handle, {
              keepWarm: live?.some((process) => process.sandboxId === handle.resourceId) ?? false,
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
    if (provisionInFlight) await provisionInFlight.catch(() => {});
    provisionInFlight = null;
    const handle = box.handle ?? box.pending;
    box.handle = null;
    box.pending = null;
    if (!handle) {
      if (ownerCleanupError) throw ownerCleanupError;
      return;
    }
    await clearTurnFiles(handle);
    if (box.residentAuthProbe) await box.residentAuthProbe.catch(() => {});
    let keepWarm = false;
    if (deps.processes && supportsProcessSessions(deps.sandbox)) {
      try {
        keepWarm = (await deps.processes.liveByScope(memoryScopeId)).length > 0;
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
  };

  return {
    box,
    scratchBox,
    ownerAuthBox,
    ownerAuthCommand,
    scopedCommand,
    provision,
    provisionScratch,
    provisionResource,
    provisionOwnerAuth,
    ensureSkillTree,
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
