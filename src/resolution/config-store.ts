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
import { composeSharingPostures, type SharingPosture } from "./sharing-posture.ts";
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
export interface PersistedSharingPosture {
  scopeId: ScopeId;
  posture: SharingPosture;
}
export interface PersistedApprovalGrantModes {
  scopeId: ScopeId;
  modes: ApprovalGrantModes;
}
export interface PersistedEgressPolicy {
  scopeId: ScopeId;
  policy: EgressPolicy;
}
export type ModelAccount = "company" | "personal" | "anthropic" | "openai";

export interface PersistedModelAccount extends PersistedScopedFlag {
  provider?: "anthropic" | "openai";
}

export interface PersistedScopedFlag {
  scopeId: ScopeId;
  on: boolean;
}
export interface PersistedBaseModel {
  scopeId: ScopeId;
  embeddingModelId?: string;
  modelId?: string;
  cronRuntime?: RuntimeSelection;
  subagentRuntime?: RuntimeSelection;
  fallbackRuntime?: RuntimeSelection;
  harnessId?: string;
  orgRevision?: number;
  revision?: number;
  effortLevel?: string;
  fastMode?: boolean;
}
export type RuntimePurpose = "cron" | "subagent" | "fallback";

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
export interface PersistedInternalMemberOverrides {
  scopeId: ScopeId;
  members: string[];
}
export interface PersistedAckEmoji {
  scopeId: ScopeId;
  names: string[];
}
export interface PersistedPinnedSkills {
  scopeId: ScopeId;
  names: string[];
}
export interface PersistedSlackEmojiCatalog {
  scopeId: ScopeId;
  emoji: Record<string, string>;
  updatedAt: number;
}

export interface PersistedPeopleDirectoryUrl {
  scopeId: ScopeId;
  url: string;
}
export interface OrgBranding {
  accent?: string;
  mark?: string;
  markUrl?: string;
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
interface AutoFlaggerConfig {
  harnessId: string;
  modelId: string;
  rubric: string;
}
export interface PersistedAutoFlaggerConfig extends AutoFlaggerConfig {
  scopeId: ScopeId;
}
interface ScopeConfigPresence {
  soul: boolean;
  commandPolicy: boolean;
  securityPosture: boolean;
  sharingPosture: boolean;
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
  setSoul(id: ScopeId, content: string, updatedBy?: string): Promise<number>;
  setSoulIfVersion(id: ScopeId, expectedVersion: number, content: string, updatedBy?: string): Promise<number | null>;
  soulVersion(id: ScopeId): number;
  soulHistory(id: ScopeId): PersistedSoulRevision[];
  captureSoulSnapshot(id: ScopeId): Promise<SoulSnapshot>;
  restoreSoulSnapshot(id: ScopeId, snapshot: SoulSnapshot): Promise<boolean>;
  restoreSoulCacheSnapshot(id: ScopeId, snapshot: SoulSnapshot): void;
  getCommandPolicy(id: ScopeId): CommandPolicy | null;
  setCommandPolicy(id: ScopeId, policy: CommandPolicy): Promise<void>;
  getSecurityPosture(id: ScopeId): SecurityPosture;
  getSecurityPostureDurable(id: ScopeId): Promise<SecurityPosture>;
  setSecurityPosture(id: ScopeId, posture: SecurityPosture): Promise<void>;
  getSharingPosture(id: ScopeId): SharingPosture;
  getSharingPostureDurable(id: ScopeId): Promise<SharingPosture>;
  getSharingPostureOwnDurable(id: ScopeId): Promise<SharingPosture | null>;
  resolveSharingPostureDurable(personalId: ScopeId, targetId: ScopeId): Promise<SharingPosture>;
  setSharingPosture(id: ScopeId, posture: SharingPosture): Promise<void>;
  clearSharingPosture(id: ScopeId): Promise<void>;
  getApprovalGrantModes(id: ScopeId): ApprovalGrantModes;
  getApprovalGrantModesDurable(id: ScopeId): Promise<ApprovalGrantModes>;
  setApprovalGrantModes(id: ScopeId, modes: ApprovalGrantModes): Promise<void>;
  getEgress(id: ScopeId): EgressPolicy | null;
  setEgress(id: ScopeId, policy: EgressPolicy): Promise<void>;
  getUnfulfilledInsights(id: ScopeId): boolean;
  setUnfulfilledInsights(id: ScopeId, on: boolean): Promise<void>;
  getExternalSlackParticipants(id: ScopeId): boolean;
  setExternalSlackParticipants(id: ScopeId, on: boolean): Promise<void>;
  getExternalSlackParticipantsDurable(id: ScopeId): Promise<boolean>;
  getChannelHeaderPin(id: ScopeId): boolean;
  setChannelHeaderPin(id: ScopeId, on: boolean | null): Promise<void>;
  getChannelHeaderPinDurable(id: ScopeId): Promise<boolean>;
  getChannelHeaderPinOverrideDurable(id: ScopeId): Promise<boolean | null>;
  getChannelHeaderPinDefaultDurable(): Promise<boolean>;
  onChannelHeaderPinChanged(listener: (id: ScopeId) => void): void;
  getPurposeRuntime(purpose: RuntimePurpose): RuntimeSelection | undefined;
  getPurposeRuntimeDurable(purpose: RuntimePurpose): Promise<RuntimeSelection | undefined>;
  setPurposeRuntime(purpose: RuntimePurpose, selection: RuntimeSelection): Promise<void>;
  clearPurposeRuntime(purpose: RuntimePurpose): Promise<void>;
  getBaseModel(id: ScopeId): string | null;
  setBaseModel(id: ScopeId, modelId: string | null): Promise<void>;
  getRuntimeSelection(id: ScopeId): ScopedRuntimeSelection | null;
  setRuntimeSelection(id: ScopeId, selection: RuntimeSelection | null): Promise<void>;
  acknowledgeRuntimeSelection(id: ScopeId): Promise<void>;
  getRuntimeSelectionDurable(id: ScopeId): Promise<ScopedRuntimeSelection | null>;
  onRuntimeSelectionChanged(listener: (id: ScopeId) => void): void;
  getApprovedHarnesses(): string[] | null;
  setApprovedHarnesses(ids: string[] | null): Promise<void>;
  getApprovedHarnessesDurable(): Promise<string[] | null>;
  getInternalMemberOverrides(): string[];
  setInternalMemberOverrides(members: string[]): Promise<void>;
  getInternalMemberOverridesDurable(): Promise<string[]>;
  getOrgAmbient(): boolean;
  setOrgAmbient(on: boolean): Promise<void>;
  getOrgAmbientDurable(): Promise<boolean>;
  getInteractiveFastMode(): boolean;
  setInteractiveFastMode(on: boolean): Promise<void>;
  getInteractiveFastModeDurable(): Promise<boolean>;
  getIndividualModelAuth(): boolean;
  setIndividualModelAuth(on: boolean): Promise<void>;
  getIndividualModelAuthDurable(principalId?: string): Promise<boolean>;
  setPersonalModelAuth(principalId: string, on: boolean, provider?: "anthropic" | "openai"): Promise<void>;
  getModelAccountDurable(principalId: string): Promise<ModelAccount>;
  getBaseModelOwnDurable(id: ScopeId): Promise<string | null>;
  getWebuiModels(id: ScopeId): string[] | null;
  setWebuiModels(id: ScopeId, ids: string[] | null): Promise<void>;
  getBaseModelDurable(id: ScopeId): Promise<string | null>;
  getWebuiModelsDurable(id: ScopeId): Promise<string[] | null>;
  getAckEmoji(id: ScopeId): string[] | null;
  setAckEmoji(id: ScopeId, names: string[] | null): Promise<void>;
  getAckEmojiDurable(id: ScopeId): Promise<string[] | null>;
  getPinnedSkillsDurable(id: ScopeId): Promise<string[]>;
  setPinnedSkills(id: ScopeId, names: string[]): Promise<void>;
  setSlackEmojiCatalog(id: ScopeId, emoji: Record<string, string>): Promise<void>;
  getSlackEmojiCatalogDurable(id: ScopeId): Promise<PersistedSlackEmojiCatalog | null>;
  getPeopleDirectoryUrl(id: ScopeId): string | null;
  setPeopleDirectoryUrl(id: ScopeId, url: string | null): Promise<void>;
  getBranding(id: ScopeId): OrgBranding | null;
  setBranding(id: ScopeId, branding: OrgBranding | null): Promise<void>;
  getBrandingDurable(id: ScopeId): Promise<OrgBranding | null>;
  getBrowseMaxSteps(id: ScopeId): number | null;
  setBrowseMaxSteps(id: ScopeId, steps: number | null): Promise<void>;
  getBrowseModel(id: ScopeId): string | null;
  setBrowseModel(id: ScopeId, modelId: string | null): Promise<void>;
  getEmbeddingModelDurable(): Promise<string | null>;
  setEmbeddingModel(modelId: string | null): Promise<void>;
  getAutoFlaggerConfig(): AutoFlaggerConfig | null;
  setAutoFlaggerConfig(config: AutoFlaggerConfig | null): Promise<void>;
  setConnectorClient(id: ScopeId, provider: string, input: ConnectorClientInput): Promise<void>;
  listConnectorClients(id: ScopeId): Promise<PublicConnectorClient[]>;
  deleteConnectorClient(id: ScopeId, provider: string): Promise<void>;
  getConnectorClientSecret(id: ScopeId, provider: string): Promise<DecryptedConnectorClient | null>;
  scopeConfigPresence(id: ScopeId): Promise<ScopeConfigPresence>;
  refreshScope(id: ScopeId): Promise<void>;
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
    sharingPostures?: DurableMap<PersistedSharingPosture>;
    approvalGrantModes?: DurableMap<PersistedApprovalGrantModes>;
    egressPolicies?: DurableMap<PersistedEgressPolicy>;
    unfulfilledInsights?: DurableMap<PersistedScopedFlag>;
    externalSlackParticipants?: DurableMap<PersistedScopedFlag>;
    channelHeaderPin?: DurableMap<PersistedScopedFlag>;
    baseModels?: DurableMap<PersistedBaseModel>;
    approvedHarnesses?: DurableMap<PersistedApprovedHarnesses>;
    internalMemberOverrides?: DurableMap<PersistedInternalMemberOverrides>;
    orgAmbient?: DurableMap<PersistedScopedFlag>;
    interactiveFastMode?: DurableMap<PersistedScopedFlag>;
    individualModelAuth?: DurableMap<PersistedModelAccount>;
    webuiModels?: DurableMap<PersistedWebuiModels>;
    peopleDirectoryUrls?: DurableMap<PersistedPeopleDirectoryUrl>;
    ackEmoji?: DurableMap<PersistedAckEmoji>;
    pinnedSkills?: DurableMap<PersistedPinnedSkills>;
    slackEmojiCatalog?: DurableMap<PersistedSlackEmojiCatalog>;
    branding?: DurableMap<PersistedBranding>;
    browseMaxSteps?: DurableMap<PersistedBrowseMaxSteps>;
    browseModels?: DurableMap<PersistedBrowseModel>;
    autoFlaggerConfigs?: DurableMap<PersistedAutoFlaggerConfig>;
    deploymentIdentity?: DurableMap<PersistedDeploymentIdentity>;
    connectorSecretKey?: Buffer | string;
    defaultSecurityPosture?: SecurityPosture;
    defaultSharingPosture?: SharingPosture;
  } = {},
): ScopedConfigStore {
  const souls = new Map<ScopeId, { content: string; version: number }>();
  const soulHistory = new Map<ScopeId, PersistedSoulRevision[]>();
  const legacySoulHistory = new Map<ScopeId, PersistedSoulRevision[]>();
  const policies = new Map<ScopeId, CommandPolicy>();
  const securityPostures = new Map<ScopeId, SecurityPosture>();
  const sharingPostures = new Map<ScopeId, SharingPosture>();
  const approvalGrantModesCache = new Map<ScopeId, ApprovalGrantModes>();
  const egress = new Map<ScopeId, EgressPolicy>();
  const unfulfilledInsights = new Map<ScopeId, boolean>();
  const externalSlackParticipants = new Map<ScopeId, boolean>();
  const channelHeaderPin = new Map<ScopeId, boolean>();
  const baseModels = new Map<ScopeId, PersistedBaseModel>();
  let approvedHarnesses: string[] | null = null;
  let internalMemberOverrides: string[] = [];
  let orgAmbient = true;
  let interactiveFastMode = false;
  let individualModelAuth = false;
  const webuiModels = new Map<ScopeId, string[]>();
  const peopleDirectoryUrls = new Map<ScopeId, string>();
  const ackEmoji = new Map<ScopeId, string[]>();
  const branding = new Map<ScopeId, OrgBranding>();
  const browseMaxSteps = new Map<ScopeId, number>();
  const browseModels = new Map<ScopeId, string>();
  let autoFlaggerConfig: AutoFlaggerConfig | null = null;
  const soulStore = opts.souls ?? createMemoryMap<PersistedSoul>();
  const soulHistoryStore = opts.soulHistory ?? createMemoryMap<PersistedSoulRevision>();
  const commandPolicyStore = opts.commandPolicies ?? createMemoryMap<PersistedCommandPolicy>();
  const securityPostureStore = opts.securityPostures ?? createMemoryMap<PersistedSecurityPosture>();
  const sharingPostureStore = opts.sharingPostures ?? createMemoryMap<PersistedSharingPosture>();
  const approvalGrantModesStore = opts.approvalGrantModes ?? createMemoryMap<PersistedApprovalGrantModes>();
  const egressStore = opts.egressPolicies ?? createMemoryMap<PersistedEgressPolicy>();
  const unfulfilledInsightsStore = opts.unfulfilledInsights ?? createMemoryMap<PersistedScopedFlag>();
  const externalSlackParticipantsStore = opts.externalSlackParticipants ?? createMemoryMap<PersistedScopedFlag>();
  const channelHeaderPinStore = opts.channelHeaderPin ?? createMemoryMap<PersistedScopedFlag>();
  const baseModelStore = opts.baseModels ?? createMemoryMap<PersistedBaseModel>();
  const approvedHarnessStore = opts.approvedHarnesses ?? createMemoryMap<PersistedApprovedHarnesses>();
  const internalMemberOverridesStore =
    opts.internalMemberOverrides ?? createMemoryMap<PersistedInternalMemberOverrides>();
  const orgAmbientStore = opts.orgAmbient ?? createMemoryMap<PersistedScopedFlag>();
  const interactiveFastModeStore = opts.interactiveFastMode ?? createMemoryMap<PersistedScopedFlag>();
  const individualModelAuthStore = opts.individualModelAuth ?? createMemoryMap<PersistedModelAccount>();
  const webuiModelStore = opts.webuiModels ?? createMemoryMap<PersistedWebuiModels>();
  const peopleDirectoryUrlStore = opts.peopleDirectoryUrls ?? createMemoryMap<PersistedPeopleDirectoryUrl>();
  const ackEmojiStore = opts.ackEmoji ?? createMemoryMap<PersistedAckEmoji>();
  const pinnedSkillsStore = opts.pinnedSkills ?? createMemoryMap<PersistedPinnedSkills>();
  const slackEmojiCatalogStore = opts.slackEmojiCatalog ?? createMemoryMap<PersistedSlackEmojiCatalog>();
  const brandingStore = opts.branding ?? createMemoryMap<PersistedBranding>();
  const browseMaxStepsStore = opts.browseMaxSteps ?? createMemoryMap<PersistedBrowseMaxSteps>();
  const browseModelStore = opts.browseModels ?? createMemoryMap<PersistedBrowseModel>();
  const autoFlaggerStore = opts.autoFlaggerConfigs ?? createMemoryMap<PersistedAutoFlaggerConfig>();
  const deploymentIdentity = opts.deploymentIdentity ?? createMemoryMap<PersistedDeploymentIdentity>();
  const writeQueue = createKeyedQueue();
  // Writes land in the durable store before the cache changes, so a setter that resolves
  // means the value is saved and a rejected one leaves this process agreeing with the store.
  const save = (key: string, write: () => Promise<unknown>, apply: () => void): Promise<void> =>
    writeQueue(key, async () => {
      await write();
      apply();
    });
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
  const purposeFields = (id: ScopeId, row?: PersistedBaseModel | null) =>
    id === org
      ? {
          ...(row?.embeddingModelId ? { embeddingModelId: row.embeddingModelId } : {}),
          ...(row?.cronRuntime ? { cronRuntime: row.cronRuntime } : {}),
          ...(row?.subagentRuntime ? { subagentRuntime: row.subagentRuntime } : {}),
          ...(row?.fallbackRuntime ? { fallbackRuntime: row.fallbackRuntime } : {}),
        }
      : {};
  const withoutRuntime = (id: ScopeId, row: PersistedBaseModel | null): PersistedBaseModel => ({
    scopeId: id,
    ...purposeFields(id, row),
  });
  const updateBaseModelRow = async (
    id: ScopeId,
    fn: (row: PersistedBaseModel | null) => PersistedBaseModel,
  ): Promise<PersistedBaseModel | null> => {
    if (!baseModelStore.update || !baseModelStore.insertIfAbsent || !baseModelStore.deleteIf)
      throw new Error("base model store does not support atomic updates");
    for (;;) {
      let saved = await baseModelStore.update(id, fn);
      if (!saved) {
        const fresh = fn(null);
        if (Object.keys(fresh).length <= 1) return null;
        if (!(await baseModelStore.insertIfAbsent(id, fresh))) continue;
        saved = fresh;
      }
      if (Object.keys(saved).length > 1) return saved;
      await baseModelStore.deleteIf(id, (row) => Object.keys(row).length <= 1);
      return null;
    }
  };
  const cacheBaseModel = (id: ScopeId, row: PersistedBaseModel | null): void => {
    if (row) baseModels.set(id, row);
    else baseModels.delete(id);
  };
  const setPurposeRuntime = async (purpose: RuntimePurpose, selection?: RuntimeSelection) => {
    await writeQueue(`model:${org}`, async () => {
      const key = `${purpose}Runtime` as const;
      const saved = await updateBaseModelRow(org, (current) => {
        const row: PersistedBaseModel = { ...current, scopeId: org };
        if (selection) row[key] = { ...selection };
        else delete row[key];
        return row;
      });
      cacheBaseModel(org, saved);
    });
  };
  const defaultSecurityPosture = opts.defaultSecurityPosture ?? "auto";
  const defaultSharingPosture = opts.defaultSharingPosture ?? "isolated";
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
      // Each reload queues behind this process's writes to the same key, so it never
      // overwrites a newer local write with the row it read before that write landed.
      const reload = <T>(key: string, read: () => Promise<T>, apply: (row: T) => void) =>
        writeQueue(key, async () => apply(await read()));
      await Promise.all(
        ids.flatMap((id) => [
          reload(
            `soul:${id}`,
            () => soulStore.get(id),
            (soul) => {
              if (soul) souls.set(id, { content: soul.content, version: soul.version });
              else if (id !== org) souls.delete(id);
            },
          ),
          reload(
            `policy:${id}`,
            () => commandPolicyStore.get(id),
            (policy) => {
              if (policy) policies.set(id, policy.policy);
              else if (id !== org) policies.delete(id);
            },
          ),
          reload(
            `egress:${id}`,
            () => egressStore.get(id),
            (egressPolicy) => {
              if (egressPolicy) egress.set(id, egressPolicy.policy);
              else if (id !== org) egress.delete(id);
            },
          ),
          reload(
            `sharingPosture:${id}`,
            () => sharingPostureStore.get(id),
            (sharingPosture) => {
              if (sharingPosture) sharingPostures.set(id, sharingPosture.posture);
              else sharingPostures.delete(id);
            },
          ),
        ]),
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
          for (const r of await sharingPostureStore.all()) sharingPostures.set(r.scopeId, r.posture);
          for (const r of await approvalGrantModesStore.all()) approvalGrantModesCache.set(r.scopeId, r.modes);
          for (const r of await egressStore.all()) egress.set(r.scopeId, r.policy);
          for (const r of await unfulfilledInsightsStore.all()) unfulfilledInsights.set(r.scopeId, r.on);
          for (const r of await externalSlackParticipantsStore.all()) externalSlackParticipants.set(r.scopeId, r.on);
          for (const r of await channelHeaderPinStore.all()) channelHeaderPin.set(r.scopeId, r.on);
          for (const r of await baseModelStore.all()) baseModels.set(r.scopeId, r);
          approvedHarnesses = (await approvedHarnessStore.get(org))?.ids ?? null;
          internalMemberOverrides = (await internalMemberOverridesStore.get(org))?.members ?? [];
          orgAmbient = (await orgAmbientStore.get(org))?.on ?? true;
          interactiveFastMode = (await interactiveFastModeStore.get(org))?.on ?? false;
          individualModelAuth = (await individualModelAuthStore.get(org))?.on ?? false;
          for (const r of await webuiModelStore.all()) webuiModels.set(r.scopeId, r.ids);
          for (const r of await peopleDirectoryUrlStore.all()) peopleDirectoryUrls.set(r.scopeId, r.url);
          for (const r of await ackEmojiStore.all()) ackEmoji.set(r.scopeId, r.names);
          for (const r of await brandingStore.all()) branding.set(r.scopeId, r.branding);
          for (const r of await browseMaxStepsStore.all()) browseMaxSteps.set(r.scopeId, r.steps);
          for (const r of await browseModelStore.all()) browseModels.set(r.scopeId, r.modelId);
          const storedAutoFlagger = await autoFlaggerStore.get(org);
          autoFlaggerConfig = storedAutoFlagger
            ? {
                harnessId: storedAutoFlagger.harnessId,
                modelId: storedAutoFlagger.modelId,
                rubric: storedAutoFlagger.rubric,
              }
            : null;
        })();
      }
      return hydrated;
    },
    getSoul: (id) => souls.get(id)?.content ?? null,
    setSoul(id, content, updatedBy) {
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
      return save(
        `policy:${id}`,
        () => commandPolicyStore.put(id, { scopeId: id, policy }),
        () => policies.set(id, policy),
      );
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
    getSharingPosture(id) {
      const orgPosture = sharingPostures.get(org) ?? defaultSharingPosture;
      return id === org ? orgPosture : composeSharingPostures(orgPosture, [sharingPostures.get(id)]);
    },
    async getSharingPostureDurable(id) {
      const orgPosture = (await sharingPostureStore.get(org))?.posture ?? defaultSharingPosture;
      return id === org
        ? orgPosture
        : composeSharingPostures(orgPosture, [(await sharingPostureStore.get(id))?.posture]);
    },
    async getSharingPostureOwnDurable(id) {
      return (await sharingPostureStore.get(id))?.posture ?? null;
    },
    async resolveSharingPostureDurable(personalId, targetId) {
      const [orgRow, personalRow, targetRow] = await Promise.all([
        sharingPostureStore.get(org),
        sharingPostureStore.get(personalId),
        sharingPostureStore.get(targetId),
      ]);
      return composeSharingPostures(orgRow?.posture ?? defaultSharingPosture, [
        personalId === org ? undefined : personalRow?.posture,
        targetId === org || targetId === personalId ? undefined : targetRow?.posture,
      ]);
    },
    async setSharingPosture(id, posture) {
      await writeQueue(`sharingPosture:${id}`, () => sharingPostureStore.put(id, { scopeId: id, posture }));
      sharingPostures.set(id, posture);
    },
    async clearSharingPosture(id) {
      await writeQueue(`sharingPosture:${id}`, () => sharingPostureStore.delete(id));
      sharingPostures.delete(id);
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
    getEgress: (id) => egress.get(id) ?? null,
    setEgress(id, policy) {
      return save(
        `egress:${id}`,
        () => egressStore.put(id, { scopeId: id, policy }),
        () => egress.set(id, policy),
      );
    },
    getUnfulfilledInsights: (id) => (unfulfilledInsights.get(org) ?? false) || (unfulfilledInsights.get(id) ?? false),
    setUnfulfilledInsights(id, on) {
      return save(
        `unfulfilled:${id}`,
        () => unfulfilledInsightsStore.put(id, { scopeId: id, on }),
        () => unfulfilledInsights.set(id, on),
      );
    },
    getExternalSlackParticipants: (id) =>
      (externalSlackParticipants.get(org) ?? false) || (externalSlackParticipants.get(id) ?? false),
    setExternalSlackParticipants(id, on) {
      return save(
        `externalSlack:${id}`,
        () => externalSlackParticipantsStore.put(id, { scopeId: id, on }),
        () => externalSlackParticipants.set(id, on),
      );
    },
    getExternalSlackParticipantsDurable: async (id) =>
      ((await externalSlackParticipantsStore.get(org))?.on ?? false) ||
      ((await externalSlackParticipantsStore.get(id))?.on ?? false),
    getChannelHeaderPin: (id) => channelHeaderPin.get(id) ?? channelHeaderPin.get(org) ?? false,
    async setChannelHeaderPin(id, on) {
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
    getPurposeRuntime: (purpose) => {
      const selection = baseModels.get(org)?.[`${purpose}Runtime`];
      return selection ? { ...selection } : undefined;
    },
    getPurposeRuntimeDurable: async (purpose) => {
      const selection = (await baseModelStore.get(org))?.[`${purpose}Runtime`];
      return selection ? { ...selection } : undefined;
    },
    setPurposeRuntime,
    clearPurposeRuntime: (purpose) => setPurposeRuntime(purpose),
    getBaseModel: (id) => baseModels.get(id)?.modelId ?? null,
    async setBaseModel(id, modelId) {
      await writeQueue(`model:${id}`, async () => {
        const saved = await updateBaseModelRow(id, (current) => {
          if (modelId === null) return withoutRuntime(id, current);
          const harnessId = current?.harnessId;
          if (harnessId && isHarnessId(harnessId) && !modelSupportedByHarness(modelId, harnessId)) return current!;
          return { ...current, scopeId: id, modelId };
        });
        cacheBaseModel(id, saved);
      });
      noteRuntimeSelectionChanged(id);
    },
    getRuntimeSelection(id) {
      const row = baseModels.get(id);
      if (!row?.harnessId || !row.modelId) return null;
      return {
        harnessId: row.harnessId,
        modelId: row.modelId,
        orgRevision: row.orgRevision ?? 0,
        ...(row.revision !== undefined ? { revision: row.revision } : {}),
        ...(row.effortLevel !== undefined ? { effortLevel: row.effortLevel } : {}),
        ...(row.fastMode !== undefined ? { fastMode: row.fastMode } : {}),
      };
    },
    async setRuntimeSelection(id, selection) {
      await writeQueue(`model:${id}`, async () => {
        if (selection === null) {
          cacheBaseModel(id, await updateBaseModelRow(id, (row) => withoutRuntime(id, row)));
          return;
        }
        const orgRevision = id === org ? 0 : ((await baseModelStore.get(org))?.revision ?? 0);
        const saved = await updateBaseModelRow(id, (row) => {
          if (id !== org) return { scopeId: id, ...selection, orgRevision };
          const revision = (row?.revision ?? 0) + 1;
          return { scopeId: id, ...purposeFields(id, row), ...selection, revision, orgRevision: revision };
        });
        cacheBaseModel(id, saved);
      });
      noteRuntimeSelectionChanged(id);
    },
    async acknowledgeRuntimeSelection(id) {
      if (id === org) return;
      await writeQueue(`model:${id}`, async () => {
        const orgRevision = (await baseModelStore.get(org))?.revision ?? 0;
        const saved = await baseModelStore.merge(id, { orgRevision });
        if (saved) baseModels.set(id, saved);
      });
    },
    onRuntimeSelectionChanged(listener) {
      runtimeSelectionListeners.add(listener);
    },
    getRuntimeSelectionDurable: async (id) => {
      const row = await baseModelStore.get(id);
      if (!row?.harnessId || !row.modelId) return null;
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
      return save(
        `approvedHarnesses:${org}`,
        () => (next ? approvedHarnessStore.put(org, { scopeId: org, ids: next }) : approvedHarnessStore.delete(org)),
        () => (approvedHarnesses = next),
      );
    },
    getApprovedHarnessesDurable: async () => (await approvedHarnessStore.get(org))?.ids ?? null,
    getInternalMemberOverrides: () => [...internalMemberOverrides],
    setInternalMemberOverrides(members) {
      const next = [...new Set(members.map((m) => m.trim().toLowerCase()).filter(Boolean))];
      return save(
        `internalMemberOverrides:${org}`,
        () => internalMemberOverridesStore.put(org, { scopeId: org, members: next }),
        () => (internalMemberOverrides = next),
      );
    },
    getInternalMemberOverridesDurable: async () => (await internalMemberOverridesStore.get(org))?.members ?? [],
    getOrgAmbient: () => orgAmbient,
    setOrgAmbient(on) {
      return save(
        `orgAmbient:${org}`,
        () => orgAmbientStore.put(org, { scopeId: org, on }),
        () => (orgAmbient = on),
      );
    },
    getOrgAmbientDurable: async () => (await orgAmbientStore.get(org))?.on ?? true,
    getInteractiveFastMode: () => interactiveFastMode,
    setInteractiveFastMode(on) {
      return save(
        `interactiveFastMode:${org}`,
        () => interactiveFastModeStore.put(org, { scopeId: org, on }),
        () => (interactiveFastMode = on),
      );
    },
    getInteractiveFastModeDurable: async () => (await interactiveFastModeStore.get(org))?.on ?? false,
    getIndividualModelAuth: () => individualModelAuth,
    setIndividualModelAuth(on) {
      return save(
        `individualModelAuth:${org}`,
        () => individualModelAuthStore.put(org, { scopeId: org, on }),
        () => (individualModelAuth = on),
      );
    },
    async getIndividualModelAuthDurable(principalId) {
      if ((await individualModelAuthStore.get(org))?.on) return true;
      return principalId
        ? ((await individualModelAuthStore.get(scopeId("personal", principalId)))?.on ?? false)
        : false;
    },
    async getModelAccountDurable(principalId) {
      const row = await individualModelAuthStore.get(scopeId("personal", principalId));
      if (row?.on) return row.provider ?? "personal";
      return (await individualModelAuthStore.get(org))?.on ? "personal" : "company";
    },
    async setPersonalModelAuth(principalId, on, provider) {
      const id = scopeId("personal", principalId);
      await individualModelAuthStore.put(id, { scopeId: id, on, ...(on && provider ? { provider } : {}) });
    },
    getBaseModelOwnDurable: async (id) => (await baseModelStore.get(id))?.modelId ?? null,
    getBaseModelDurable: async (id) =>
      (await baseModelStore.get(id))?.modelId ??
      (id === org ? null : ((await baseModelStore.get(org))?.modelId ?? null)),
    getWebuiModels: (id) => webuiModels.get(id) ?? null,
    setWebuiModels(id, ids) {
      const clear = ids === null || ids.length === 0;
      return save(
        `webuiModels:${id}`,
        () => (clear ? webuiModelStore.delete(id) : webuiModelStore.put(id, { scopeId: id, ids })),
        () => (clear ? webuiModels.delete(id) : webuiModels.set(id, ids)),
      );
    },
    getWebuiModelsDurable: async (id) =>
      (await webuiModelStore.get(id))?.ids ?? (await webuiModelStore.get(org))?.ids ?? null,
    getAckEmoji: (id) => ackEmoji.get(id) ?? null,
    setAckEmoji(id, names) {
      const clear = !names || !names.length;
      return save(
        `ackEmoji:${id}`,
        () => (clear ? ackEmojiStore.delete(id) : ackEmojiStore.put(id, { scopeId: id, names })),
        () => (clear ? ackEmoji.delete(id) : ackEmoji.set(id, names)),
      );
    },
    getAckEmojiDurable: async (id) => (await ackEmojiStore.get(id))?.names ?? null,
    getPinnedSkillsDurable: async (id) => (await pinnedSkillsStore.get(id))?.names ?? [],
    setPinnedSkills: (id, names) =>
      writeQueue(`pinnedSkills:${id}`, () =>
        names.length ? pinnedSkillsStore.put(id, { scopeId: id, names }) : pinnedSkillsStore.delete(id),
      ),
    async setSlackEmojiCatalog(id, emoji) {
      await writeQueue(`slackEmojiCatalog:${id}`, () =>
        slackEmojiCatalogStore.put(id, { scopeId: id, emoji, updatedAt: Date.now() }),
      );
    },
    getSlackEmojiCatalogDurable: async (id) => (await slackEmojiCatalogStore.get(id)) ?? null,
    getPeopleDirectoryUrl: (id) => peopleDirectoryUrls.get(id) ?? null,
    setPeopleDirectoryUrl(id, url) {
      const clear = url === null;
      return save(
        `peopleDir:${id}`,
        () => (clear ? peopleDirectoryUrlStore.delete(id) : peopleDirectoryUrlStore.put(id, { scopeId: id, url })),
        () => (clear ? peopleDirectoryUrls.delete(id) : peopleDirectoryUrls.set(id, url)),
      );
    },
    getBranding: (id) => branding.get(id) ?? null,
    setBranding(id, value) {
      const clear = value === null;
      return save(
        `branding:${id}`,
        () => (clear ? brandingStore.delete(id) : brandingStore.put(id, { scopeId: id, branding: value })),
        () => (clear ? branding.delete(id) : branding.set(id, value)),
      );
    },
    getBrandingDurable: async (id) => (await brandingStore.get(id))?.branding ?? null,
    getBrowseMaxSteps: (id) => browseMaxSteps.get(id) ?? null,
    setBrowseMaxSteps(id, steps) {
      const clear = steps === null;
      return save(
        `browseSteps:${id}`,
        () => (clear ? browseMaxStepsStore.delete(id) : browseMaxStepsStore.put(id, { scopeId: id, steps })),
        () => (clear ? browseMaxSteps.delete(id) : browseMaxSteps.set(id, steps)),
      );
    },
    getBrowseModel: (id) => browseModels.get(id) ?? null,
    setBrowseModel(id, modelId) {
      const clear = modelId === null;
      return save(
        `browseModel:${id}`,
        () => (clear ? browseModelStore.delete(id) : browseModelStore.put(id, { scopeId: id, modelId })),
        () => (clear ? browseModels.delete(id) : browseModels.set(id, modelId)),
      );
    },
    getEmbeddingModelDurable: async () => (await baseModelStore.get(org))?.embeddingModelId ?? null,
    setEmbeddingModel: async (modelId) => {
      await writeQueue(`model:${org}`, async () => {
        const saved = await updateBaseModelRow(org, (current) => {
          const row: PersistedBaseModel = { ...current, scopeId: org };
          if (modelId) row.embeddingModelId = modelId;
          else delete row.embeddingModelId;
          return row;
        });
        cacheBaseModel(org, saved);
      });
    },
    getAutoFlaggerConfig: () => autoFlaggerConfig,
    setAutoFlaggerConfig(config) {
      return save(
        `autoFlagger:${org}`,
        () => (config === null ? autoFlaggerStore.delete(org) : autoFlaggerStore.put(org, { scopeId: org, ...config })),
        () => (autoFlaggerConfig = config),
      );
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
        sharingPosture,
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
        sharingPostureStore.get(id),
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
        sharingPosture: !!sharingPosture,
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
        sharingPosture,
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
        autoFlaggerRow,
        internalOverridesRow,
      ] = await Promise.all([
        soulStore.get(id),
        commandPolicyStore.get(id),
        securityPostureStore.get(id),
        sharingPostureStore.get(id),
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
        id === org ? autoFlaggerStore.get(org) : null,
        id === org ? internalMemberOverridesStore.get(org) : null,
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
      if (sharingPosture) sharingPostures.set(id, sharingPosture.posture);
      else sharingPostures.delete(id);
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
      if (id === org) internalMemberOverrides = internalOverridesRow?.members ?? [];
      if (id === org) orgAmbient = orgAmbientRow?.on ?? true;
      if (id === org) interactiveFastMode = interactiveFastModeRow?.on ?? false;
      if (id === org) individualModelAuth = individualModelAuthRow?.on ?? false;
      if (id === org)
        autoFlaggerConfig = autoFlaggerRow
          ? { harnessId: autoFlaggerRow.harnessId, modelId: autoFlaggerRow.modelId, rubric: autoFlaggerRow.rubric }
          : null;
      if (brandingRow) branding.set(id, brandingRow.branding);
      else branding.delete(id);
      if (channelHeaderPinRow) channelHeaderPin.set(id, channelHeaderPinRow.on);
      else channelHeaderPin.delete(id);
    },
  };
}
