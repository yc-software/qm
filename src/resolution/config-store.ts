import { tenantRootScope } from "../tenants/context.ts";
import type { ApprovalGrantModes, CommandPolicy, EgressPolicy, ScopeId } from "../types.ts";
import { scopeId } from "../types.ts";
import { randomBytes } from "node:crypto";
import { createKeyedQueue } from "../util/async.ts";
import type { SecurityPosture } from "../security/security-posture.ts";
import type { SharingPosture } from "./sharing-posture.ts";
import type {
  ConnectorClientInput,
  PublicConnectorClient,
  DecryptedConnectorClient,
} from "../connectors/connector-client-store.ts";
import { deriveConnectorKey } from "../connectors/connector-client-store.ts";
import { currentTenant } from "../tenants/context.ts";
import {
  type AutoFlaggerConfig,
  type ConfigTables,
  type ModelAccount,
  type OperatorSettings,
  type OrgBranding,
  type RuntimePurpose,
  type RuntimeSelection,
  type ScopeSettings,
  type SlackEmojiCatalog,
  type SoulRevision,
} from "./config-tables.ts";
import {
  connectorMethods,
  operatorMethods,
  policyMethods,
  preferenceMethods,
  runtimeMethods,
  soulMethods,
  type ConfigContext,
  type TenantConfig,
} from "./config-store-methods.ts";

export type { ModelAccount, OrgBranding, RuntimePurpose } from "./config-tables.ts";

export interface ScopedRuntimeSelection extends RuntimeSelection {
  orgRevision: number;
  revision?: number;
}

export interface ScopedConfigStore {
  refreshSecurity(ids: ScopeId[]): Promise<void>;
  getSoul(id: ScopeId): string | null;
  setSoul(id: ScopeId, content: string, updatedBy?: string): Promise<number>;
  setSoulIfVersion(id: ScopeId, expectedVersion: number, content: string, updatedBy?: string): Promise<number | null>;
  soulVersion(id: ScopeId): number;
  soulHistory(id: ScopeId): SoulRevision[];
  getCommandPolicy(id: ScopeId): CommandPolicy | null;
  setCommandPolicy(id: ScopeId, policy: CommandPolicy): Promise<void>;
  getSecurityPostureDurable(id: ScopeId): Promise<SecurityPosture>;
  getSecurityPostureOwnDurable(id: ScopeId): Promise<SecurityPosture | null>;
  setSecurityPosture(id: ScopeId, posture: SecurityPosture): Promise<void>;
  getSharingPostureDurable(id: ScopeId): Promise<SharingPosture>;
  getSharingPostureOwnDurable(id: ScopeId): Promise<SharingPosture | null>;
  resolveSharingPostureDurable(personalId: ScopeId, targetId: ScopeId): Promise<SharingPosture>;
  setSharingPosture(id: ScopeId, posture: SharingPosture): Promise<void>;
  clearSharingPosture(id: ScopeId): Promise<void>;
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
  setSlackEmojiCatalog(id: ScopeId, emoji: Record<string, string>): Promise<void>;
  getSlackEmojiCatalogDurable(id: ScopeId): Promise<SlackEmojiCatalog | null>;
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
  refreshScope(id: ScopeId): Promise<void>;
  hydrate(): Promise<void>;
}

const SOUL_HISTORY_LIMIT = 25;

const emptyTenantConfig = (): TenantConfig => ({ scopes: new Map(), souls: new Map(), purposes: {} });

function groupSouls(revisions: readonly SoulRevision[]): Map<ScopeId, SoulRevision[]> {
  const souls = new Map<ScopeId, SoulRevision[]>();
  for (const revision of revisions) souls.set(revision.scopeId, [...(souls.get(revision.scopeId) ?? []), revision]);
  return souls;
}

function tenantCache(tables: ConfigTables) {
  const tenants = new Map<string, TenantConfig>();
  const loads = new Map<string, Promise<void>>();
  const written = new Map<string, number>();
  let tick = 0;
  const operator: { settings: OperatorSettings } = { settings: {} };
  const writeKey = (id: ScopeId) => `${currentTenant()}|${id}`;
  const loaded = (): TenantConfig | undefined => {
    const tenant = currentTenant();
    const found = tenants.get(tenant);
    if (found || !tables.fresh) return found;
    const created = emptyTenantConfig();
    tenants.set(tenant, created);
    return created;
  };
  const cached = (): TenantConfig => {
    const found = loaded();
    if (found) return found;
    void hydrate();
    throw new Error(`Configuration for tenant ${currentTenant()} has not been loaded`);
  };
  const load = async (tenant: string) => {
    const [scopes, souls, purposes, settings] = await Promise.all([
      tables.scopeSettings(),
      tables.soulRevisions(SOUL_HISTORY_LIMIT),
      tables.purposeRuntimes(),
      tables.operatorSettings(),
    ]);
    operator.settings = settings;
    tenants.set(tenant, { scopes: new Map(scopes), souls: groupSouls(souls), purposes });
  };
  const setSouls = (target: TenantConfig, id: ScopeId, souls: SoulRevision[] | undefined) => {
    if (souls?.length) target.souls.set(id, souls);
    else target.souls.delete(id);
  };
  function hydrate(): Promise<void> {
    const tenant = currentTenant();
    let pending = loads.get(tenant);
    if (!pending) {
      pending = load(tenant);
      pending.catch(() => loads.delete(tenant));
      loads.set(tenant, pending);
    }
    return pending;
  }
  return {
    loaded,
    cached,
    operator,
    hydrate,
    markWritten: (id: ScopeId) => void written.set(writeKey(id), ++tick),
    async refresh(ids: readonly ScopeId[], withOrg: boolean) {
      const target = loaded();
      if (!target) return hydrate();
      if (!ids.length) return;
      const since = tick;
      const [rows, heads] = await Promise.all([tables.scopeSettings(ids), tables.soulRevisions(1, ids)]);
      const head = new Map(heads.map((r) => [r.scopeId, r.version]));
      const moved = ids.filter((id) => (head.get(id) ?? 0) !== (target.souls.get(id)?.[0]?.version ?? 0));
      const histories = moved.length ? groupSouls(await tables.soulRevisions(SOUL_HISTORY_LIMIT, moved)) : new Map();
      const settings = new Map(rows);
      for (const id of ids) {
        if ((written.get(writeKey(id)) ?? 0) > since) continue;
        const row = settings.get(id);
        if (row) target.scopes.set(id, row);
        else target.scopes.delete(id);
        if (moved.includes(id)) setSouls(target, id, histories.get(id));
      }
      if (!withOrg || !ids.includes(tenantRootScope())) return;
      [target.purposes, operator.settings] = await Promise.all([tables.purposeRuntimes(), tables.operatorSettings()]);
    },
    async reloadSouls(id: ScopeId) {
      const souls = await tables.soulRevisions(SOUL_HISTORY_LIMIT, [id]);
      const target = loaded();
      if (target) setSouls(target, id, souls);
    },
  };
}

export function createConfigStore(opts: {
    tables: ConfigTables;
    connectorSecretKey?: Buffer | string;
    defaultSecurityPosture?: SecurityPosture;
    defaultSharingPosture?: SharingPosture;
}): ScopedConfigStore {
  const { tables } = opts;
  const cache = tenantCache(tables);
  const keyed = createKeyedQueue();
  const queue = <T>(key: string, fn: () => Promise<T>) => keyed(`${currentTenant()}|${key}`, fn);
  const writeScope = (id: ScopeId, fn: (current: ScopeSettings) => ScopeSettings) =>
    queue(`scope:${id}`, async () => {
      const next = await tables.updateScopeSetting(id, fn);
      cache.loaded()?.scopes.set(id, next);
      cache.markWritten(id);
      return next;
    });
  const ctx: ConfigContext = {
    get org() {
      return tenantRootScope();
    },
    tables,
    queue,
    scope: (id) => cache.cached().scopes.get(id),
    own: async (id) => (await tables.scopeSetting(id)) ?? {},
    writeScope,
    async put(id, key, value) {
      await writeScope(id, (current) => ({ ...current, [key]: value ?? undefined }));
    },
    cached: cache.cached,
    loaded: cache.loaded,
    reloadSouls: cache.reloadSouls,
    markWritten: cache.markWritten,
    operator: cache.operator,
    defaultSecurityPosture: opts.defaultSecurityPosture ?? "auto",
    defaultSharingPosture: opts.defaultSharingPosture ?? "isolated",
    connectorKey: deriveConnectorKey(opts.connectorSecretKey ?? randomBytes(32), "connector-clients"),
  };
  return {
    ...soulMethods(ctx),
    ...policyMethods(ctx),
    ...runtimeMethods(ctx),
    ...preferenceMethods(ctx),
    ...operatorMethods(ctx),
    ...connectorMethods(ctx),
    hydrate: cache.hydrate,
    refreshScope: (id) => cache.refresh([id], true),
    refreshSecurity: (ids) => cache.refresh([...new Set(ids)], false),
  };
}
