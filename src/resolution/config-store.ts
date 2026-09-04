import type { CommandPolicy, EgressPolicy, ScopeId } from "../types.ts";
import { scopeId } from "../types.ts";
import { defaultOrgPolicy } from "../policy/command-policy.ts";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createMemoryMap } from "../persistence/durable-map.ts";
import { createKeyedQueue } from "../util/async.ts";
import { isHarnessId, modelSupportedByHarness } from "../model/pi-models.ts";
import { composeSecurityPosture, type SecurityPosture } from "../security/security-posture.ts";
import type { ApprovalGrantModes } from "../types.ts";
import {
  deriveConnectorKey,
  encryptSecret,
  decryptSecret,
  toPublicConnectorClient,
  type StoredConnectorClient,
  type ConnectorClientInput,
  type PublicConnectorClient,
  type DecryptedConnectorClient,
} from "../connectors/connector-client-store.ts";
import { errMessage } from "../util/errors.ts";

export interface PersistedSoul {
  scopeId: ScopeId;
  content: string;
  version: number;
  updatedAt?: number;
  updatedBy?: string;
  history?: PersistedSoulRevision[];
  mutationId?: string;
}
export interface PersistedSoulRevision {
  scopeId: ScopeId;
  content: string;
  version: number;
  updatedAt: number;
  updatedBy?: string;
}
type SoulSnapshot = PersistedSoul | null;
export interface PersistedCommandPolicy {
  scopeId: ScopeId;
  policy: CommandPolicy;
}
export interface PersistedSecurityPosture {
  scopeId: ScopeId;
  posture: SecurityPosture;
}
export interface PersistedApprovalGrantModes {
  scopeId: ScopeId;
  modes: ApprovalGrantModes;
}
export interface PersistedEgressPolicy {
  scopeId: ScopeId;
  policy: EgressPolicy;
}
export interface PersistedScopedFlag {
  scopeId: ScopeId;
  on: boolean;
}
export interface PersistedBaseModel {
  scopeId: ScopeId;
  modelId: string;
  harnessId?: string;
  orgRevision?: number;
  revision?: number;
  effortLevel?: string;
  fastMode?: boolean;
}
interface RuntimeSelection {
  harnessId: string;
  modelId: string;
  effortLevel?: string;
  fastMode?: boolean;
}
interface ScopedRuntimeSelection extends RuntimeSelection {
  orgRevision: number;
  revision?: number;
}
export interface PersistedApprovedHarnesses {
  scopeId: ScopeId;
  ids: string[];
}
export interface PersistedWebuiModels {
  scopeId: ScopeId;
  ids: string[];
}
export interface PersistedAckEmoji {
  scopeId: ScopeId;
  names: string[];
}

export interface PersistedPeopleDirectoryUrl {
  scopeId: ScopeId;
  url: string;
}
export interface OrgBranding {
  accent?: string;
  mark?: string;
  selfLabel?: string;
  orgName?: string;
}
export interface PersistedBranding {
  scopeId: ScopeId;
  branding: OrgBranding;
}
export interface PersistedBrowseMaxSteps {
  scopeId: ScopeId;
  steps: number;
}
export interface PersistedBrowseModel {
  scopeId: ScopeId;
  modelId: string;
}
export interface PersistedTurnWallClock {
  scopeId: ScopeId;
  sec: number;
}
interface ScopeConfigPresence {
  soul: boolean;
  commandPolicy: boolean;
  securityPosture: boolean;
  approvalGrantModes: boolean;
  egress: boolean;
  unfulfilledInsights: boolean;
  externalSlackParticipants: boolean;
  runtime: boolean;
  approvedHarnesses: boolean;
  branding: boolean;
}

export interface PersistedDeploymentIdentity {
  orgId: string;
}
export interface ScopedConfigStore {
  refreshSecurity(ids: ScopeId[]): Promise<void>;
  getSoul(id: ScopeId): string | null;
  setSoul(id: ScopeId, content: string, updatedBy?: string): number;
  setSoulLatest(id: ScopeId, content: string, updatedBy?: string): Promise<number>;
  clearSoul(id: ScopeId): void;
  setSoulIfVersion(id: ScopeId, expectedVersion: number, content: string, updatedBy?: string): Promise<number | null>;
  soulVersion(id: ScopeId): number;
  soulHistory(id: ScopeId): PersistedSoulRevision[];
  captureSoulSnapshot(id: ScopeId): Promise<SoulSnapshot>;
  restoreSoulSnapshot(id: ScopeId, snapshot: SoulSnapshot): Promise<boolean>;
  restoreSoulCacheSnapshot(id: ScopeId, snapshot: SoulSnapshot): void;
  getCommandPolicy(id: ScopeId): CommandPolicy | null;
  setCommandPolicy(id: ScopeId, policy: CommandPolicy): void;
  clearCommandPolicy(id: ScopeId): void;
  getSecurityPosture(id: ScopeId): SecurityPosture;
  getSecurityPostureDurable(id: ScopeId): Promise<SecurityPosture>;
  setSecurityPosture(id: ScopeId, posture: SecurityPosture): Promise<void>;
  clearSecurityPosture(id: ScopeId): void;
  getApprovalGrantModes(id: ScopeId): ApprovalGrantModes;
  getApprovalGrantModesDurable(id: ScopeId): Promise<ApprovalGrantModes>;
  setApprovalGrantModes(id: ScopeId, modes: ApprovalGrantModes): Promise<void>;
  clearApprovalGrantModes(id: ScopeId): void;
  getEgress(id: ScopeId): EgressPolicy | null;
  setEgress(id: ScopeId, policy: EgressPolicy): void;
  clearEgress(id: ScopeId): void;
  getUnfulfilledInsights(id: ScopeId): boolean;
  setUnfulfilledInsights(id: ScopeId, on: boolean): void;
  clearUnfulfilledInsights(id: ScopeId): void;
  getExternalSlackParticipants(id: ScopeId): boolean;
  setExternalSlackParticipants(id: ScopeId, on: boolean): void;
  clearExternalSlackParticipants(id: ScopeId): void;
  getExternalSlackParticipantsDurable(id: ScopeId): Promise<boolean>;
  getChannelHeaderPin(id: ScopeId): boolean;
  setChannelHeaderPinLatest(id: ScopeId, on: boolean | null): Promise<void>;
  getChannelHeaderPinDurable(id: ScopeId): Promise<boolean>;
  getChannelHeaderPinOverrideDurable(id: ScopeId): Promise<boolean | null>;
  getChannelHeaderPinDefaultDurable(): Promise<boolean>;
  onChannelHeaderPinChanged(listener: (id: ScopeId) => void): void;
  getBaseModel(id: ScopeId): string | null;
  setBaseModel(id: ScopeId, modelId: string | null): void;
  getRuntimeSelection(id: ScopeId): ScopedRuntimeSelection | null;
  setRuntimeSelection(id: ScopeId, selection: RuntimeSelection | null): void;
  setRuntimeSelectionLatest(id: ScopeId, selection: RuntimeSelection | null): Promise<void>;
  acknowledgeRuntimeSelection(id: ScopeId): void;
  acknowledgeRuntimeSelectionLatest(id: ScopeId): Promise<void>;
  getRuntimeSelectionDurable(id: ScopeId): Promise<ScopedRuntimeSelection | null>;
  onRuntimeSelectionChanged(listener: (id: ScopeId) => void): void;
  getApprovedHarnesses(): string[] | null;
  setApprovedHarnesses(ids: string[] | null): void;
  getApprovedHarnessesDurable(): Promise<string[] | null>;
  getOrgAmbient(): boolean;
  setOrgAmbient(on: boolean): void;
  getOrgAmbientDurable(): Promise<boolean>;
  getInteractiveFastMode(): boolean;
  setInteractiveFastMode(on: boolean): void;
  getInteractiveFastModeDurable(): Promise<boolean>;
  getIndividualModelAuth(): boolean;
  setIndividualModelAuth(on: boolean): void;
  getIndividualModelAuthDurable(): Promise<boolean>;
  getBaseModelOwnDurable(id: ScopeId): Promise<string | null>;
  getWebuiModels(id: ScopeId): string[] | null;
  setWebuiModels(id: ScopeId, ids: string[] | null): void;
  getBaseModelDurable(id: ScopeId): Promise<string | null>;
  getWebuiModelsDurable(id: ScopeId): Promise<string[] | null>;
  getAckEmoji(id: ScopeId): string[] | null;
  setAckEmoji(id: ScopeId, names: string[] | null): void;
  getAckEmojiDurable(id: ScopeId): Promise<string[] | null>;
  getPeopleDirectoryUrl(id: ScopeId): string | null;
  setPeopleDirectoryUrl(id: ScopeId, url: string | null): void;
  getBranding(id: ScopeId): OrgBranding | null;
  setBranding(id: ScopeId, branding: OrgBranding | null): void;
  getBrandingDurable(id: ScopeId): Promise<OrgBranding | null>;
  getBrowseMaxSteps(id: ScopeId): number | null;
  setBrowseMaxSteps(id: ScopeId, steps: number | null): void;
  getBrowseModel(id: ScopeId): string | null;
  setBrowseModel(id: ScopeId, modelId: string | null): void;
  getTurnWallClockSecDurable(id: ScopeId): Promise<number | null>;
  setTurnWallClockSec(id: ScopeId, sec: number | null): Promise<void>;
  setConnectorClient(id: ScopeId, provider: string, input: ConnectorClientInput): Promise<void>;
  listConnectorClients(id: ScopeId): Promise<PublicConnectorClient[]>;
  deleteConnectorClient(id: ScopeId, provider: string): Promise<void>;
  getConnectorClientSecret(id: ScopeId, provider: string): Promise<DecryptedConnectorClient | null>;
  scopeConfigPresence(id: ScopeId): Promise<ScopeConfigPresence>;
  refreshScope(id: ScopeId): Promise<void>;
  flushScope(id: ScopeId): Promise<void>;
  hydrate?(): Promise<void>;
}

export function createMemoryConfigStore(
  orgId: string,
  opts: {
    connectorClients?: DurableMap<StoredConnectorClient>;
    souls?: DurableMap<PersistedSoul>;
    soulHistory?: DurableMap<PersistedSoulRevision>;
    commandPolicies?: DurableMap<PersistedCommandPolicy>;
    securityPostures?: DurableMap<PersistedSecurityPosture>;
    approvalGrantModes?: DurableMap<PersistedApprovalGrantModes>;
    egressPolicies?: DurableMap<PersistedEgressPolicy>;
    unfulfilledInsights?: DurableMap<PersistedScopedFlag>;
    externalSlackParticipants?: DurableMap<PersistedScopedFlag>;
    channelHeaderPin?: DurableMap<PersistedScopedFlag>;
    baseModels?: DurableMap<PersistedBaseModel>;
    approvedHarnesses?: DurableMap<PersistedApprovedHarnesses>;
    orgAmbient?: DurableMap<PersistedScopedFlag>;
    interactiveFastMode?: DurableMap<PersistedScopedFlag>;
    individualModelAuth?: DurableMap<PersistedScopedFlag>;
    webuiModels?: DurableMap<PersistedWebuiModels>;
    peopleDirectoryUrls?: DurableMap<PersistedPeopleDirectoryUrl>;
    ackEmoji?: DurableMap<PersistedAckEmoji>;
    branding?: DurableMap<PersistedBranding>;
    browseMaxSteps?: DurableMap<PersistedBrowseMaxSteps>;
    browseModels?: DurableMap<PersistedBrowseModel>;
    turnWallClocks?: DurableMap<PersistedTurnWallClock>;
    deploymentIdentity?: DurableMap<PersistedDeploymentIdentity>;
    connectorSecretKey?: Buffer | string;
    defaultSecurityPosture?: SecurityPosture;
  } = {},
): ScopedConfigStore {
  const souls = new Map<ScopeId, { content: string; version: number }>();
  const soulHistory = new Map<ScopeId, PersistedSoulRevision[]>();
  const legacySoulHistory = new Map<ScopeId, PersistedSoulRevision[]>();
  const policies = new Map<ScopeId, CommandPolicy>();
  const securityPostures = new Map<ScopeId, SecurityPosture>();
  const approvalGrantModesCache = new Map<ScopeId, ApprovalGrantModes>();
  const egress = new Map<ScopeId, EgressPolicy>();
  const unfulfilledInsights = new Map<ScopeId, boolean>();
  const externalSlackParticipants = new Map<ScopeId, boolean>();
  const channelHeaderPin = new Map<ScopeId, boolean>();
  const baseModels = new Map<ScopeId, PersistedBaseModel>();
  let approvedHarnesses: string[] | null = null;
  let orgAmbient = true;
  let interactiveFastMode = false;
  let individualModelAuth = false;
  const webuiModels = new Map<ScopeId, string[]>();
  const peopleDirectoryUrls = new Map<ScopeId, string>();
  const ackEmoji = new Map<ScopeId, string[]>();
  const branding = new Map<ScopeId, OrgBranding>();
  const browseMaxSteps = new Map<ScopeId, number>();
  const browseModels = new Map<ScopeId, string>();
  const turnWallClocks = new Map<ScopeId, number>();
  const soulStore = opts.souls ?? createMemoryMap<PersistedSoul>();
  const soulHistoryStore = opts.soulHistory ?? createMemoryMap<PersistedSoulRevision>();
  const commandPolicyStore = opts.commandPolicies ?? createMemoryMap<PersistedCommandPolicy>();
  const securityPostureStore = opts.securityPostures ?? createMemoryMap<PersistedSecurityPosture>();
  const approvalGrantModesStore = opts.approvalGrantModes ?? createMemoryMap<PersistedApprovalGrantModes>();
  const egressStore = opts.egressPolicies ?? createMemoryMap<PersistedEgressPolicy>();
  const unfulfilledInsightsStore = opts.unfulfilledInsights ?? createMemoryMap<PersistedScopedFlag>();
  const externalSlackParticipantsStore = opts.externalSlackParticipants ?? createMemoryMap<PersistedScopedFlag>();
  const channelHeaderPinStore = opts.channelHeaderPin ?? createMemoryMap<PersistedScopedFlag>();
  const baseModelStore = opts.baseModels ?? createMemoryMap<PersistedBaseModel>();
  const approvedHarnessStore = opts.approvedHarnesses ?? createMemoryMap<PersistedApprovedHarnesses>();
  const orgAmbientStore = opts.orgAmbient ?? createMemoryMap<PersistedScopedFlag>();
  const interactiveFastModeStore = opts.interactiveFastMode ?? createMemoryMap<PersistedScopedFlag>();
  const individualModelAuthStore = opts.individualModelAuth ?? createMemoryMap<PersistedScopedFlag>();
  const webuiModelStore = opts.webuiModels ?? createMemoryMap<PersistedWebuiModels>();
  const peopleDirectoryUrlStore = opts.peopleDirectoryUrls ?? createMemoryMap<PersistedPeopleDirectoryUrl>();
  const ackEmojiStore = opts.ackEmoji ?? createMemoryMap<PersistedAckEmoji>();
  const brandingStore = opts.branding ?? createMemoryMap<PersistedBranding>();
  const browseMaxStepsStore = opts.browseMaxSteps ?? createMemoryMap<PersistedBrowseMaxSteps>();
  const browseModelStore = opts.browseModels ?? createMemoryMap<PersistedBrowseModel>();
  const turnWallClockStore = opts.turnWallClocks ?? createMemoryMap<PersistedTurnWallClock>();
  const deploymentIdentity = opts.deploymentIdentity ?? createMemoryMap<PersistedDeploymentIdentity>();
  const persistWarn = (what: string) => (e: unknown) =>
    console.error(`[config] failed to persist ${what}:`, errMessage(e));
  const writeQueue = createKeyedQueue();
  const pendingWrites = new Map<string, Promise<void>>();
  const persist = (key: string, what: string, op: () => Promise<unknown>): void => {
    const pending = writeQueue(key, async () => {
      await op();
    }).then(() => {
      if (pendingWrites.get(key) === pending) pendingWrites.delete(key);
    });
    pendingWrites.set(key, pending);
    void pending.catch(persistWarn(what));
  };
  const channelHeaderPinListeners = new Set<(id: ScopeId) => void>();
  const noteChannelHeaderPinChanged = (id: ScopeId): void => {
    for (const listener of channelHeaderPinListeners) {
      try {
        listener(id);
      } catch (e) {
        console.error("[config] channel-header-pin listener failed:", errMessage(e));
      }
    }
  };
  const runtimeSelectionListeners = new Set<(id: ScopeId) => void>();
  const noteRuntimeSelectionChanged = (id: ScopeId): void => {
    for (const listener of runtimeSelectionListeners) {
      try {
        listener(id);
      } catch (e) {
        console.error("[config] runtime-selection listener failed:", errMessage(e));
      }
    }
  };
  const connectorClients = opts.connectorClients ?? createMemoryMap<StoredConnectorClient>();
  const connectorKey = deriveConnectorKey(opts.connectorSecretKey ?? randomBytes(32), "connector-clients");
  const connectorMapKey = (id: ScopeId, provider: string) => `${id}|${provider}`;

  const org = scopeId("org", orgId);
  const defaultSecurityPosture = opts.defaultSecurityPosture ?? "auto";
  const DEFAULT_APPROVAL_GRANT_MODES: ApprovalGrantModes = { session: true, always: true };
  const composeApprovalGrantModes = (orgModes: ApprovalGrantModes, scope?: ApprovalGrantModes): ApprovalGrantModes => ({
    session: orgModes.session && (scope?.session ?? true),
    always: orgModes.always && (scope?.always ?? true),
  });
  const defaultOrgSoul = {
    content:
      "You are a helpful internal assistant for this organization. Be concise, accurate, and respect data boundaries: never reveal information to people who are not party to the current conversation.",
    version: 1,
  };
  souls.set(org, defaultOrgSoul);
  policies.set(org, defaultOrgPolicy());
  egress.set(org, { allowedHosts: [], deniedHosts: [] });

  let hydrated: Promise<void> | null = null;
  const loadSoulCache = (id: ScopeId, soul: PersistedSoul | null): void => {
    if (soul) souls.set(id, { content: soul.content, version: soul.version });
    else if (id === org) souls.set(org, defaultOrgSoul);
    else souls.delete(id);
    if (soul?.history) soulHistory.set(id, soul.history);
    else soulHistory.delete(id);
  };
  const cloneSoul = (soul: PersistedSoul | null): SoulSnapshot => (soul ? structuredClone(soul) : null);
  const sameSoul = (left: SoulSnapshot, right: SoulSnapshot): boolean => isDeepStrictEqual(left, right);
  const mergeSoulHistory = (
    embedded: readonly PersistedSoulRevision[] | undefined,
    legacy: readonly PersistedSoulRevision[],
  ): PersistedSoulRevision[] => {
    const byVersion = new Map<number, PersistedSoulRevision>();
    for (const revision of legacy) byVersion.set(revision.version, revision);
    for (const revision of embedded ?? []) byVersion.set(revision.version, revision);
    return [...byVersion.values()].sort((a, b) => b.version - a.version);
  };
  const historyIncludingCurrent = (
    current: PersistedSoul,
    legacy: readonly PersistedSoulRevision[],
  ): PersistedSoulRevision[] => {
    const history = mergeSoulHistory(current.history, legacy);
    if (!history.some((revision) => revision.version === current.version)) {
      history.push({
        scopeId: current.scopeId,
        content: current.content,
        version: current.version,
        updatedAt: current.updatedAt ?? 0,
        ...(current.updatedBy ? { updatedBy: current.updatedBy } : {}),
      });
      history.sort((a, b) => b.version - a.version);
    }
    return history;
  };

  return {
    async refreshSecurity(ids) {
      await Promise.all(
        ids.map(async (id) => {
          const [soul, policy, egressPolicy] = await Promise.all([
            soulStore.get(id),
            commandPolicyStore.get(id),
            egressStore.get(id),
          ]);
          if (!pendingWrites.has(`soul:${id}`)) {
            if (soul) souls.set(id, { content: soul.content, version: soul.version });
            else if (id !== org) souls.delete(id);
          }
          if (!pendingWrites.has(`policy:${id}`)) {
            if (policy) policies.set(id, policy.policy);
            else if (id !== org) policies.delete(id);
          }
          if (!pendingWrites.has(`egress:${id}`)) {
            if (egressPolicy) egress.set(id, egressPolicy.policy);
            else if (id !== org) egress.delete(id);
          }
        }),
      );
    },
    hydrate() {
      if (!hydrated) {
        hydrated = (async () => {
          const identity = await deploymentIdentity.putIfAbsent("singleton", { orgId });
          if (identity.orgId !== orgId) throw new Error(`database belongs to org ${identity.orgId}, not ${orgId}`);
          for (const r of await soulStore.all()) {
            souls.set(r.scopeId, { content: r.content, version: r.version });
            if (r.history?.length) soulHistory.set(r.scopeId, r.history);
          }
          for (const r of await soulHistoryStore.all()) {
            const legacyRevisions = legacySoulHistory.get(r.scopeId) ?? [];
            if (!legacyRevisions.some((revision) => revision.version === r.version)) legacyRevisions.push(r);
            legacySoulHistory.set(r.scopeId, legacyRevisions);
            const revisions = soulHistory.get(r.scopeId) ?? [];
            if (!revisions.some((revision) => revision.version === r.version)) revisions.push(r);
            soulHistory.set(r.scopeId, revisions);
          }
          for (const revisions of legacySoulHistory.values()) revisions.sort((a, b) => b.version - a.version);
          for (const revisions of soulHistory.values()) revisions.sort((a, b) => b.version - a.version);
          for (const r of await commandPolicyStore.all()) policies.set(r.scopeId, r.policy);
          for (const r of await securityPostureStore.all()) securityPostures.set(r.scopeId, r.posture);
          for (const r of await approvalGrantModesStore.all()) approvalGrantModesCache.set(r.scopeId, r.modes);
          for (const r of await egressStore.all()) egress.set(r.scopeId, r.policy);
          for (const r of await unfulfilledInsightsStore.all()) unfulfilledInsights.set(r.scopeId, r.on);
          for (const r of await externalSlackParticipantsStore.all()) externalSlackParticipants.set(r.scopeId, r.on);
          for (const r of await channelHeaderPinStore.all()) channelHeaderPin.set(r.scopeId, r.on);
          for (const r of await baseModelStore.all()) baseModels.set(r.scopeId, r);
          approvedHarnesses = (await approvedHarnessStore.get(org))?.ids ?? null;
          orgAmbient = (await orgAmbientStore.get(org))?.on ?? true;
          interactiveFastMode = (await interactiveFastModeStore.get(org))?.on ?? false;
          individualModelAuth = (await individualModelAuthStore.get(org))?.on ?? false;
          for (const r of await webuiModelStore.all()) webuiModels.set(r.scopeId, r.ids);
          for (const r of await peopleDirectoryUrlStore.all()) peopleDirectoryUrls.set(r.scopeId, r.url);
          for (const r of await ackEmojiStore.all()) ackEmoji.set(r.scopeId, r.names);
          for (const r of await brandingStore.all()) branding.set(r.scopeId, r.branding);
          for (const r of await browseMaxStepsStore.all()) browseMaxSteps.set(r.scopeId, r.steps);
          for (const r of await browseModelStore.all()) browseModels.set(r.scopeId, r.modelId);
          for (const r of await turnWallClockStore.all()) turnWallClocks.set(r.scopeId, r.sec);
        })();
      }
      return hydrated;
    },
    getSoul: (id) => souls.get(id)?.content ?? null,
    setSoul(id, content, updatedBy) {
      const version = (souls.get(id)?.version ?? 0) + 1;
      const revision: PersistedSoulRevision = {
        scopeId: id,
        content,
        version,
        updatedAt: Date.now(),
        ...(updatedBy ? { updatedBy } : {}),
      };
      const history = [revision, ...(soulHistory.get(id) ?? [])];
      souls.set(id, { content, version });
      soulHistory.set(id, history);
      persist(`soul:${id}`, "soul", () => soulStore.put(id, { ...revision, history }));
      return version;
    },
    setSoulLatest(id, content, updatedBy) {
      return writeQueue(`soul:${id}`, async () => {
        if (!soulStore.update) throw new Error("SOUL store does not support atomic updates");
        const legacy = legacySoulHistory.get(id) ?? [];
        const append = (current: PersistedSoul): PersistedSoul => {
          const revision: PersistedSoulRevision = {
            scopeId: id,
            content,
            version: current.version + 1,
            updatedAt: Date.now(),
            ...(updatedBy ? { updatedBy } : {}),
          };
          return {
            ...revision,
            history: [revision, ...historyIncludingCurrent(current, current.history === undefined ? legacy : [])],
            mutationId: randomBytes(12).toString("hex"),
          };
        };
        let saved = await soulStore.update(id, append);
        if (!saved) {
          const baseVersion = souls.get(id)?.version ?? 0;
          const revision: PersistedSoulRevision = {
            scopeId: id,
            content,
            version: baseVersion + 1,
            updatedAt: Date.now(),
            ...(updatedBy ? { updatedBy } : {}),
          };
          const mutationId = randomBytes(12).toString("hex");
          const candidate: PersistedSoul = { ...revision, history: [revision], mutationId };
          const canonical = await soulStore.putIfAbsent(id, candidate);
          saved = canonical.mutationId === mutationId ? canonical : await soulStore.update(id, append);
        }
        if (!saved) throw new Error("SOUL disappeared during atomic update");
        legacySoulHistory.delete(id);
        loadSoulCache(id, saved);
        return saved.version;
      });
    },
    clearSoul(id) {
      if (id === org) souls.set(org, defaultOrgSoul);
      else souls.delete(id);
      soulHistory.delete(id);
      legacySoulHistory.delete(id);
      persist(`soul:${id}`, "soul", async () => {
        await soulStore.delete(id);
        for (const [key, revision] of await soulHistoryStore.entries()) {
          if (revision.scopeId === id) await soulHistoryStore.delete(key);
        }
      });
    },
    async setSoulIfVersion(id, expectedVersion, content, updatedBy) {
      return writeQueue(`soul:${id}`, async () => {
        const version = expectedVersion + 1;
        const revision: PersistedSoulRevision = {
          scopeId: id,
          content,
          version,
          updatedAt: Date.now(),
          ...(updatedBy ? { updatedBy } : {}),
        };
        const legacyHistory = legacySoulHistory.get(id) ?? [];
        const mutationId = randomBytes(12).toString("hex");
        const candidate: PersistedSoul = { ...revision, history: [revision], mutationId };
        const durable = await soulStore.get(id);
        let saved: PersistedSoul;
        if (!durable) {
          if ((souls.get(id)?.version ?? 0) !== expectedVersion) return null;
          const canonical = await soulStore.putIfAbsent(id, candidate);
          if (canonical.mutationId !== mutationId) return null;
          saved = canonical;
        } else {
          if (!soulStore.update) throw new Error("SOUL store does not support atomic updates");
          let accepted = false;
          const updated = await soulStore.update(id, (current) => {
            if (current.version !== expectedVersion) return current;
            accepted = true;
            return {
              ...candidate,
              history: [
                revision,
                ...historyIncludingCurrent(current, current.history === undefined ? legacyHistory : []),
              ],
            };
          });
          if (!accepted || !updated) return null;
          saved = updated;
        }
        souls.set(id, { content: saved.content, version: saved.version });
        soulHistory.set(id, saved.history ?? [revision]);
        legacySoulHistory.delete(id);
        return saved.version;
      });
    },
    soulVersion: (id) => souls.get(id)?.version ?? 0,
    soulHistory: (id) => (soulHistory.get(id) ?? []).slice(0, 25),
    captureSoulSnapshot(id) {
      return writeQueue(`soul:${id}`, async () => cloneSoul(await soulStore.get(id)));
    },
    restoreSoulSnapshot(id, snapshot) {
      return writeQueue(`soul:${id}`, async () => {
        try {
          if (snapshot) await soulStore.put(id, cloneSoul(snapshot)!);
          else await soulStore.delete(id);
          const restored = await soulStore.get(id);
          loadSoulCache(id, restored);
          return sameSoul(restored, snapshot);
        } catch (error) {
          loadSoulCache(id, await soulStore.get(id));
          throw error;
        }
      });
    },
    restoreSoulCacheSnapshot(id, snapshot) {
      loadSoulCache(id, cloneSoul(snapshot));
    },
    getCommandPolicy: (id) => policies.get(id) ?? null,
    setCommandPolicy(id, policy) {
      policies.set(id, policy);
      persist(`policy:${id}`, "command policy", () => commandPolicyStore.put(id, { scopeId: id, policy }));
    },
    clearCommandPolicy(id) {
      if (id === org) policies.set(org, defaultOrgPolicy());
      else policies.delete(id);
      persist(`policy:${id}`, "command policy", () => commandPolicyStore.delete(id));
    },
    getSecurityPosture(id) {
      const orgPosture = securityPostures.get(org) ?? defaultSecurityPosture;
      return id === org ? orgPosture : composeSecurityPosture(orgPosture, securityPostures.get(id));
    },
    async getSecurityPostureDurable(id) {
      const orgPosture = (await securityPostureStore.get(org))?.posture ?? defaultSecurityPosture;
      if (id === org) return orgPosture;
      return composeSecurityPosture(orgPosture, (await securityPostureStore.get(id))?.posture);
    },
    async setSecurityPosture(id, posture) {
      const effective =
        id === org
          ? posture
          : composeSecurityPosture((await securityPostureStore.get(org))?.posture ?? defaultSecurityPosture, posture);
      await writeQueue(`securityPosture:${id}`, () =>
        securityPostureStore.put(id, { scopeId: id, posture: effective }),
      );
      securityPostures.set(id, effective);
    },
    clearSecurityPosture(id) {
      securityPostures.delete(id);
      persist(`securityPosture:${id}`, "security posture", () => securityPostureStore.delete(id));
    },
    getApprovalGrantModes(id) {
      const orgModes = approvalGrantModesCache.get(org) ?? DEFAULT_APPROVAL_GRANT_MODES;
      if (id === org) return { ...orgModes };
      return composeApprovalGrantModes(orgModes, approvalGrantModesCache.get(id));
    },
    async getApprovalGrantModesDurable(id) {
      const orgModes = (await approvalGrantModesStore.get(org))?.modes ?? DEFAULT_APPROVAL_GRANT_MODES;
      if (id === org) return { ...orgModes };
      return composeApprovalGrantModes(orgModes, (await approvalGrantModesStore.get(id))?.modes);
    },
    async setApprovalGrantModes(id, modes) {
      const value = { session: !!modes.session, always: !!modes.always };
      await writeQueue(`approvalGrantModes:${id}`, () =>
        approvalGrantModesStore.put(id, { scopeId: id, modes: value }),
      );
      approvalGrantModesCache.set(id, value);
    },
    clearApprovalGrantModes(id) {
      approvalGrantModesCache.delete(id);
      persist(`approvalGrantModes:${id}`, "approval grant modes", () => approvalGrantModesStore.delete(id));
    },
    getEgress: (id) => egress.get(id) ?? null,
    setEgress(id, policy) {
      egress.set(id, policy);
      persist(`egress:${id}`, "egress policy", () => egressStore.put(id, { scopeId: id, policy }));
    },
    clearEgress(id) {
      if (id === org) egress.set(org, { allowedHosts: [], deniedHosts: [] });
      else egress.delete(id);
      persist(`egress:${id}`, "egress policy", () => egressStore.delete(id));
    },
    getUnfulfilledInsights: (id) => (unfulfilledInsights.get(org) ?? false) || (unfulfilledInsights.get(id) ?? false),
    setUnfulfilledInsights(id, on) {
      unfulfilledInsights.set(id, on);
      persist(`unfulfilled:${id}`, "unfulfilled-insights flag", () =>
        unfulfilledInsightsStore.put(id, { scopeId: id, on }),
      );
    },
    clearUnfulfilledInsights(id) {
      unfulfilledInsights.delete(id);
      persist(`unfulfilled:${id}`, "unfulfilled-insights flag", () => unfulfilledInsightsStore.delete(id));
    },
    getExternalSlackParticipants: (id) =>
      (externalSlackParticipants.get(org) ?? false) || (externalSlackParticipants.get(id) ?? false),
    setExternalSlackParticipants(id, on) {
      externalSlackParticipants.set(id, on);
      persist(`externalSlack:${id}`, "external-slack-participants flag", () =>
        externalSlackParticipantsStore.put(id, { scopeId: id, on }),
      );
    },
    clearExternalSlackParticipants(id) {
      externalSlackParticipants.delete(id);
      persist(`externalSlack:${id}`, "external-slack-participants flag", () =>
        externalSlackParticipantsStore.delete(id),
      );
    },
    getExternalSlackParticipantsDurable: async (id) =>
      ((await externalSlackParticipantsStore.get(org))?.on ?? false) ||
      ((await externalSlackParticipantsStore.get(id))?.on ?? false),
    getChannelHeaderPin: (id) => channelHeaderPin.get(id) ?? channelHeaderPin.get(org) ?? false,
    async setChannelHeaderPinLatest(id, on) {
      await writeQueue(`channelHeaderPin:${id}`, async () => {
        if (on === null) await channelHeaderPinStore.delete(id);
        else await channelHeaderPinStore.put(id, { scopeId: id, on });
        if (on === null) channelHeaderPin.delete(id);
        else channelHeaderPin.set(id, on);
      });
      noteChannelHeaderPinChanged(id);
    },
    getChannelHeaderPinDurable: async (id) =>
      (await channelHeaderPinStore.get(id))?.on ??
      (id === org ? false : ((await channelHeaderPinStore.get(org))?.on ?? false)),
    getChannelHeaderPinOverrideDurable: async (id) => (await channelHeaderPinStore.get(id))?.on ?? null,
    getChannelHeaderPinDefaultDurable: async () => (await channelHeaderPinStore.get(org))?.on ?? false,
    onChannelHeaderPinChanged(listener) {
      channelHeaderPinListeners.add(listener);
    },
    getBaseModel: (id) => baseModels.get(id)?.modelId ?? null,
    setBaseModel(id, modelId) {
      if (modelId === null) {
        baseModels.delete(id);
        persist(`model:${id}`, "base model", () => baseModelStore.delete(id));
      } else {
        const prior = baseModels.get(id);
        if (prior?.harnessId && isHarnessId(prior.harnessId) && !modelSupportedByHarness(modelId, prior.harnessId))
          return;
        const row: PersistedBaseModel = { ...prior, scopeId: id, modelId };
        baseModels.set(id, row);
        persist(`model:${id}`, "base model", () => baseModelStore.put(id, row));
      }
      noteRuntimeSelectionChanged(id);
    },
    getRuntimeSelection(id) {
      const row = baseModels.get(id);
      if (!row?.harnessId) return null;
      return {
        harnessId: row.harnessId,
        modelId: row.modelId,
        orgRevision: row.orgRevision ?? 0,
        ...(row.revision !== undefined ? { revision: row.revision } : {}),
        ...(row.effortLevel !== undefined ? { effortLevel: row.effortLevel } : {}),
        ...(row.fastMode !== undefined ? { fastMode: row.fastMode } : {}),
      };
    },
    setRuntimeSelection(id, selection) {
      if (selection === null) {
        baseModels.delete(id);
        persist(`model:${id}`, "runtime selection", () => baseModelStore.delete(id));
        noteRuntimeSelectionChanged(id);
        return;
      }
      const orgRow = baseModels.get(org);
      const revision = (orgRow?.revision ?? 0) + 1;
      const row: PersistedBaseModel =
        id === org
          ? { scopeId: id, ...selection, revision, orgRevision: revision }
          : { scopeId: id, ...selection, orgRevision: orgRow?.revision ?? 0 };
      baseModels.set(id, row);
      persist(`model:${id}`, "runtime selection", () => baseModelStore.put(id, row));
      noteRuntimeSelectionChanged(id);
    },
    async setRuntimeSelectionLatest(id, selection) {
      await writeQueue(`model:${id}`, async () => {
        if (selection === null) {
          await baseModelStore.delete(id);
          baseModels.delete(id);
          return;
        }
        const orgRow = await baseModelStore.get(org);
        const revision = (orgRow?.revision ?? 0) + 1;
        const row: PersistedBaseModel =
          id === org
            ? { scopeId: id, ...selection, revision, orgRevision: revision }
            : { scopeId: id, ...selection, orgRevision: orgRow?.revision ?? 0 };
        await baseModelStore.put(id, row);
        baseModels.set(id, row);
      });
      noteRuntimeSelectionChanged(id);
    },
    acknowledgeRuntimeSelection(id) {
      const row = baseModels.get(id);
      if (!row || id === org) return;
      const next = { ...row, orgRevision: baseModels.get(org)?.revision ?? 0 };
      baseModels.set(id, next);
      persist(`model:${id}`, "runtime selection acknowledgment", () => baseModelStore.put(id, next));
    },
    async acknowledgeRuntimeSelectionLatest(id) {
      if (id === org) return;
      await writeQueue(`model:${id}`, async () => {
        const row = await baseModelStore.get(id);
        if (!row) return;
        const orgRow = await baseModelStore.get(org);
        const next = { ...row, orgRevision: orgRow?.revision ?? 0 };
        await baseModelStore.put(id, next);
        baseModels.set(id, next);
      });
    },
    onRuntimeSelectionChanged(listener) {
      runtimeSelectionListeners.add(listener);
    },
    getRuntimeSelectionDurable: async (id) => {
      const row = await baseModelStore.get(id);
      if (!row?.harnessId) return null;
      return {
        harnessId: row.harnessId,
        modelId: row.modelId,
        orgRevision: row.orgRevision ?? 0,
        ...(row.revision !== undefined ? { revision: row.revision } : {}),
        ...(row.effortLevel !== undefined ? { effortLevel: row.effortLevel } : {}),
        ...(row.fastMode !== undefined ? { fastMode: row.fastMode } : {}),
      };
    },
    getApprovedHarnesses: () => (approvedHarnesses ? [...approvedHarnesses] : null),
    setApprovedHarnesses(ids) {
      const next = ids ? [...ids] : null;
      approvedHarnesses = next;
      if (next)
        persist(`approvedHarnesses:${org}`, "approved harnesses", () =>
          approvedHarnessStore.put(org, { scopeId: org, ids: next }),
        );
      else persist(`approvedHarnesses:${org}`, "approved harnesses", () => approvedHarnessStore.delete(org));
    },
    getApprovedHarnessesDurable: async () => (await approvedHarnessStore.get(org))?.ids ?? null,
    getOrgAmbient: () => orgAmbient,
    setOrgAmbient(on) {
      orgAmbient = on;
      persist(`orgAmbient:${org}`, "org ambient switch", () => orgAmbientStore.put(org, { scopeId: org, on }));
    },
    getOrgAmbientDurable: async () => (await orgAmbientStore.get(org))?.on ?? true,
    getInteractiveFastMode: () => interactiveFastMode,
    setInteractiveFastMode(on) {
      interactiveFastMode = on;
      persist(`interactiveFastMode:${org}`, "interactive fast mode switch", () =>
        interactiveFastModeStore.put(org, { scopeId: org, on }),
      );
    },
    getInteractiveFastModeDurable: async () => (await interactiveFastModeStore.get(org))?.on ?? false,
    getIndividualModelAuth: () => individualModelAuth,
    setIndividualModelAuth(on) {
      individualModelAuth = on;
      persist(`individualModelAuth:${org}`, "individual model auth switch", () =>
        individualModelAuthStore.put(org, { scopeId: org, on }),
      );
    },
    getIndividualModelAuthDurable: async () => (await individualModelAuthStore.get(org))?.on ?? false,
    getBaseModelOwnDurable: async (id) => (await baseModelStore.get(id))?.modelId ?? null,
    getBaseModelDurable: async (id) =>
      (await baseModelStore.get(id))?.modelId ??
      (id === org ? null : ((await baseModelStore.get(org))?.modelId ?? null)),
    getWebuiModels: (id) => webuiModels.get(id) ?? null,
    setWebuiModels(id, ids) {
      if (ids === null || ids.length === 0) {
        webuiModels.delete(id);
        persist(`webuiModels:${id}`, "web-ui models", () => webuiModelStore.delete(id));
      } else {
        webuiModels.set(id, ids);
        persist(`webuiModels:${id}`, "web-ui models", () => webuiModelStore.put(id, { scopeId: id, ids }));
      }
    },
    getWebuiModelsDurable: async (id) =>
      (await webuiModelStore.get(id))?.ids ?? (await webuiModelStore.get(org))?.ids ?? null,
    getAckEmoji: (id) => ackEmoji.get(id) ?? null,
    setAckEmoji(id, names) {
      if (!names || !names.length) {
        ackEmoji.delete(id);
        persist(`ackEmoji:${id}`, "ack emoji", () => ackEmojiStore.delete(id));
      } else {
        ackEmoji.set(id, names);
        persist(`ackEmoji:${id}`, "ack emoji", () => ackEmojiStore.put(id, { scopeId: id, names }));
      }
    },
    getAckEmojiDurable: async (id) => {
      const pending = pendingWrites.get(`ackEmoji:${id}`);
      if (pending) await pending;
      return (await ackEmojiStore.get(id))?.names ?? null;
    },
    getPeopleDirectoryUrl: (id) => peopleDirectoryUrls.get(id) ?? null,
    setPeopleDirectoryUrl(id, url) {
      if (url === null) {
        peopleDirectoryUrls.delete(id);
        persist(`peopleDir:${id}`, "people directory url", () => peopleDirectoryUrlStore.delete(id));
      } else {
        peopleDirectoryUrls.set(id, url);
        persist(`peopleDir:${id}`, "people directory url", () => peopleDirectoryUrlStore.put(id, { scopeId: id, url }));
      }
    },
    getBranding: (id) => branding.get(id) ?? null,
    setBranding(id, value) {
      if (value === null) {
        branding.delete(id);
        persist(`branding:${id}`, "branding", () => brandingStore.delete(id));
      } else {
        branding.set(id, value);
        persist(`branding:${id}`, "branding", () => brandingStore.put(id, { scopeId: id, branding: value }));
      }
    },
    getBrandingDurable: async (id) => (await brandingStore.get(id))?.branding ?? null,
    getBrowseMaxSteps: (id) => browseMaxSteps.get(id) ?? null,
    setBrowseMaxSteps(id, steps) {
      if (steps === null) {
        browseMaxSteps.delete(id);
        persist(`browseSteps:${id}`, "browse max steps", () => browseMaxStepsStore.delete(id));
      } else {
        browseMaxSteps.set(id, steps);
        persist(`browseSteps:${id}`, "browse max steps", () => browseMaxStepsStore.put(id, { scopeId: id, steps }));
      }
    },
    getBrowseModel: (id) => browseModels.get(id) ?? null,
    setBrowseModel(id, modelId) {
      if (modelId === null) {
        browseModels.delete(id);
        persist(`browseModel:${id}`, "browse model", () => browseModelStore.delete(id));
      } else {
        browseModels.set(id, modelId);
        persist(`browseModel:${id}`, "browse model", () => browseModelStore.put(id, { scopeId: id, modelId }));
      }
    },
    getTurnWallClockSecDurable: async (id) => (await turnWallClockStore.get(id))?.sec ?? null,
    async setTurnWallClockSec(id, sec) {
      await writeQueue(`turnWallClock:${id}`, () =>
        sec === null ? turnWallClockStore.delete(id) : turnWallClockStore.put(id, { scopeId: id, sec }),
      );
      if (sec === null) turnWallClocks.delete(id);
      else turnWallClocks.set(id, sec);
    },
    async setConnectorClient(id, provider, input) {
      const rec: StoredConnectorClient = {
        scopeId: id,
        provider,
        clientId: input.clientId,
        secretEnc: encryptSecret(input.clientSecret, connectorKey),
        ...(input.scopes ? { scopes: input.scopes } : {}),
        ...(input.redirectAllowlist ? { redirectAllowlist: input.redirectAllowlist } : {}),
        ...(input.consentMode ? { consentMode: input.consentMode } : {}),
        ...(input.hostedDomain ? { hostedDomain: input.hostedDomain } : {}),
        enabled: input.enabled !== false,
        ...(input.updatedBy ? { updatedBy: input.updatedBy } : {}),
        updatedAt: Date.now(),
      };
      await connectorClients.put(connectorMapKey(id, provider), rec);
    },
    listConnectorClients: async (id) =>
      (await connectorClients.all()).filter((r) => r.scopeId === id).map(toPublicConnectorClient),
    deleteConnectorClient: (id, provider) => connectorClients.delete(connectorMapKey(id, provider)),
    async getConnectorClientSecret(id, provider) {
      const rec = await connectorClients.get(connectorMapKey(id, provider));
      if (!rec) return null;
      return {
        clientId: rec.clientId,
        clientSecret: decryptSecret(rec.secretEnc, connectorKey),
        ...(rec.scopes ? { scopes: rec.scopes } : {}),
        ...(rec.redirectAllowlist ? { redirectAllowlist: rec.redirectAllowlist } : {}),
        ...(rec.consentMode ? { consentMode: rec.consentMode } : {}),
        ...(rec.hostedDomain ? { hostedDomain: rec.hostedDomain } : {}),
        enabled: rec.enabled,
      };
    },
    async scopeConfigPresence(id) {
      const [
        soul,
        commandPolicy,
        securityPosture,
        grantModes,
        egressPolicy,
        unfulfilled,
        externalSlack,
        runtime,
        approved,
        brandingRow,
      ] = await Promise.all([
        soulStore.get(id),
        commandPolicyStore.get(id),
        securityPostureStore.get(id),
        approvalGrantModesStore.get(id),
        egressStore.get(id),
        unfulfilledInsightsStore.get(id),
        externalSlackParticipantsStore.get(id),
        baseModelStore.get(id),
        id === org ? approvedHarnessStore.get(org) : null,
        brandingStore.get(id),
      ]);
      return {
        soul: !!soul,
        commandPolicy: !!commandPolicy,
        securityPosture: !!securityPosture,
        approvalGrantModes: !!grantModes,
        egress: !!egressPolicy,
        unfulfilledInsights: !!unfulfilled,
        externalSlackParticipants: !!externalSlack,
        runtime: !!runtime,
        approvedHarnesses: !!approved,
        branding: !!brandingRow,
      };
    },
    async refreshScope(id) {
      const [
        soul,
        commandPolicy,
        securityPosture,
        grantModes,
        egressPolicy,
        unfulfilled,
        externalSlack,
        baseModel,
        approved,
        brandingRow,
        orgAmbientRow,
        interactiveFastModeRow,
        individualModelAuthRow,
        channelHeaderPinRow,
      ] = await Promise.all([
        soulStore.get(id),
        commandPolicyStore.get(id),
        securityPostureStore.get(id),
        approvalGrantModesStore.get(id),
        egressStore.get(id),
        unfulfilledInsightsStore.get(id),
        externalSlackParticipantsStore.get(id),
        baseModelStore.get(id),
        id === org ? approvedHarnessStore.get(org) : null,
        brandingStore.get(id),
        id === org ? orgAmbientStore.get(org) : null,
        id === org ? interactiveFastModeStore.get(org) : null,
        id === org ? individualModelAuthStore.get(org) : null,
        channelHeaderPinStore.get(id),
      ]);
      let refreshedSoul = soul;
      const legacyHistory = legacySoulHistory.get(id) ?? [];
      if (soul && soul.history === undefined && legacyHistory.length) {
        const mergedHistory = mergeSoulHistory(soul.history, legacyHistory);
        if (!isDeepStrictEqual(mergedHistory, soul.history ?? [])) {
          refreshedSoul = soulStore.update
            ? await soulStore.update(id, (current) =>
                current.history !== undefined
                  ? current
                  : { ...current, history: mergeSoulHistory(current.history, legacyHistory) },
              )
            : { ...soul, history: mergedHistory };
        }
        legacySoulHistory.delete(id);
      } else if (soul?.history !== undefined) {
        legacySoulHistory.delete(id);
      }
      loadSoulCache(id, refreshedSoul);
      if (commandPolicy) policies.set(id, commandPolicy.policy);
      else if (id === org) policies.set(org, defaultOrgPolicy());
      else policies.delete(id);
      if (securityPosture) securityPostures.set(id, securityPosture.posture);
      else securityPostures.delete(id);
      if (grantModes) approvalGrantModesCache.set(id, grantModes.modes);
      else approvalGrantModesCache.delete(id);
      if (egressPolicy) egress.set(id, egressPolicy.policy);
      else if (id === org) egress.set(org, { allowedHosts: [], deniedHosts: [] });
      else egress.delete(id);
      if (unfulfilled) unfulfilledInsights.set(id, unfulfilled.on);
      else unfulfilledInsights.delete(id);
      if (externalSlack) externalSlackParticipants.set(id, externalSlack.on);
      else externalSlackParticipants.delete(id);
      if (baseModel) baseModels.set(id, baseModel);
      else baseModels.delete(id);
      if (id === org) approvedHarnesses = approved?.ids ?? null;
      if (id === org) orgAmbient = orgAmbientRow?.on ?? true;
      if (id === org) interactiveFastMode = interactiveFastModeRow?.on ?? false;
      if (id === org) individualModelAuth = individualModelAuthRow?.on ?? false;
      if (brandingRow) branding.set(id, brandingRow.branding);
      else branding.delete(id);
      if (channelHeaderPinRow) channelHeaderPin.set(id, channelHeaderPinRow.on);
      else channelHeaderPin.delete(id);
    },
    async flushScope(id) {
      const keys = [
        `soul:${id}`,
        `policy:${id}`,
        `securityPosture:${id}`,
        `approvalGrantModes:${id}`,
        `egress:${id}`,
        `externalSlack:${id}`,
        `model:${id}`,
        `turnWallClock:${id}`,
        `branding:${id}`,
        ...(id === org
          ? [
              `approvedHarnesses:${org}`,
              `orgAmbient:${org}`,
              `interactiveFastMode:${org}`,
              `individualModelAuth:${org}`,
            ]
          : []),
        `channelHeaderPin:${id}`,
        `ackEmoji:${id}`,
      ];
      await Promise.all(
        keys.map(async (key) => {
          const pending = pendingWrites.get(key);
          if (pending) await pending;
          await writeQueue(key, async () => undefined);
        }),
      );
    },
  };
}
