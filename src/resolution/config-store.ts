import type { ApprovalGrantModes, CommandPolicy, EgressPolicy, ScopeId } from "../types.ts";
import { scopeId } from "../types.ts";
import { defaultOrgPolicy } from "../policy/command-policy.ts";
import { createKeyedQueue } from "../util/async.ts";
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
import { reportFailure } from "../util/errors.ts";
import { type ConfigTables, openConfigTables } from "./config-tables.ts";
import type { TypedTable } from "../persistence/typed-table.ts";
import { createInstructions } from "./config-instructions.ts";
import { perTenant, tenant } from "../tenant.ts";

export interface PersistedInstructions {
  scopeId: ScopeId;
  content: string;
  version: number;
  updatedAt?: number;
  updatedBy?: string;
  history?: PersistedInstructionsRevision[];
}
export interface PersistedInstructionsRevision {
  scopeId: ScopeId;
  content: string;
  version: number;
  updatedAt: number;
  updatedBy?: string;
}
type InstructionsSnapshot = PersistedInstructions | null;
type ScopedRow<K extends string, V> = { scopeId: ScopeId } & Record<K, V>;
type PersistedApprovalGrantModes = ScopedRow<"modes", ApprovalGrantModes>;
type PersistedEgressPolicy = ScopedRow<"policy", EgressPolicy>;
export type ModelAccount = "company" | "personal" | "anthropic" | "openai";

interface PersistedModelAccount extends PersistedScopedFlag {
  provider?: "anthropic" | "openai";
}

type PersistedScopedFlag = ScopedRow<"on", boolean>;
export interface PersistedBaseModel {
  scopeId: ScopeId;
  embeddingModelId?: string;
  modelId?: string;
  cronRuntime?: RuntimeSelection;
  subagentRuntime?: RuntimeSelection;
  fallbackRuntime?: RuntimeSelection;
  orgRevision?: number;
  revision?: number;
  effortLevel?: string;
  fastMode?: boolean;
}
export type RuntimePurpose = "cron" | "subagent" | "fallback";

interface RuntimeSelection {
  modelId: string;
  effortLevel?: string;
  fastMode?: boolean;
}
interface ScopedRuntimeSelection extends RuntimeSelection {
  orgRevision: number;
  revision?: number;
}
interface PersistedSlackEmojiCatalog {
  scopeId: ScopeId;
  emoji: Record<string, string>;
  updatedAt: number;
}

export interface OrgBranding {
  accent?: string;
  mark?: string;
  markUrl?: string;
  selfLabel?: string;
  orgName?: string;
}
interface AutoFlaggerConfig {
  modelId: string;
  rubric: string;
}
interface PersistedAutoFlaggerConfig extends AutoFlaggerConfig {
  scopeId: ScopeId;
}
interface PersistedDeploymentIdentity {
  orgId: string;
}
export interface ScopedConfigStore {
  setting<K extends ScopeSettingName>(name: K, id?: ScopeId): ScopeSettingValues[K];
  settingDurable<K extends ScopeSettingName>(name: K, id?: ScopeId): Promise<ScopeSettingValues[K]>;
  settingOwnDurable<K extends ScopeSettingName>(name: K, id: ScopeId): Promise<ScopeSettingValue<K> | null>;
  setSetting<K extends ScopeSettingName>(name: K, value: ScopeSettingValue<K> | null, id?: ScopeId): Promise<void>;
  refreshSecurity(ids: ScopeId[]): Promise<void>;
  getInstructions(id: ScopeId): string | null;
  getInstructionsDurable(id: ScopeId): Promise<string | null>;
  setInstructions(id: ScopeId, content: string, updatedBy?: string): Promise<number>;
  setInstructionsIfVersion(
    id: ScopeId,
    expectedVersion: number,
    content: string,
    updatedBy?: string,
  ): Promise<number | null>;
  instructionsVersion(id: ScopeId): number;
  instructionsHistory(id: ScopeId): PersistedInstructionsRevision[];
  captureInstructionsSnapshot(id: ScopeId): Promise<InstructionsSnapshot>;
  restoreInstructionsSnapshot(id: ScopeId, snapshot: InstructionsSnapshot): Promise<boolean>;
  restoreInstructionsCacheSnapshot(id: ScopeId, snapshot: InstructionsSnapshot): void;
  getApprovalGrantModes(id: ScopeId): ApprovalGrantModes;
  getApprovalGrantModesDurable(id: ScopeId): Promise<ApprovalGrantModes>;
  setApprovalGrantModes(id: ScopeId, modes: ApprovalGrantModes): Promise<void>;
  onChannelHeaderPinChanged(listener: (id: ScopeId) => void): void;
  getPurposeRuntime(purpose: RuntimePurpose): RuntimeSelection | undefined;
  getPurposeRuntimeDurable(purpose: RuntimePurpose): Promise<RuntimeSelection | undefined>;
  setPurposeRuntime(purpose: RuntimePurpose, selection: RuntimeSelection): Promise<void>;
  clearPurposeRuntime(purpose: RuntimePurpose): Promise<void>;
  getRuntimeSelection(id: ScopeId): ScopedRuntimeSelection | null;
  setRuntimeSelection(id: ScopeId, selection: RuntimeSelection | null): Promise<void>;
  acknowledgeRuntimeSelection(id: ScopeId): Promise<void>;
  getRuntimeSelectionDurable(id: ScopeId): Promise<ScopedRuntimeSelection | null>;
  onRuntimeSelectionChanged(listener: (id: ScopeId) => void): void;
  getIndividualModelAuthDurable(principalId?: string): Promise<boolean>;
  setPersonalModelAuth(principalId: string, on: boolean, provider?: "anthropic" | "openai"): Promise<void>;
  getModelAccountDurable(principalId: string): Promise<ModelAccount>;
  setSlackEmojiCatalog(id: ScopeId, emoji: Record<string, string>): Promise<void>;
  getSlackEmojiCatalogDurable(id: ScopeId): Promise<PersistedSlackEmojiCatalog | null>;
  getEmbeddingModelDurable(): Promise<string | null>;
  setEmbeddingModel(modelId: string | null): Promise<void>;
  setConnectorClient(id: ScopeId, provider: string, input: ConnectorClientInput): Promise<void>;
  listConnectorClients(id: ScopeId): Promise<PublicConnectorClient[]>;
  deleteConnectorClient(id: ScopeId, provider: string): Promise<boolean>;
  getConnectorClientSecret(id: ScopeId, provider: string): Promise<DecryptedConnectorClient | null>;
  refreshScope(id: ScopeId): Promise<void>;
  hydrate?(): Promise<void>;
}

interface ConfigRecords {
  connectorClients: StoredConnectorClient;
  instructions: PersistedInstructions;
  instructionsHistory: PersistedInstructionsRevision;
  commandPolicies: ScopedRow<"policy", CommandPolicy>;
  approvalGrantModes: PersistedApprovalGrantModes;
  egressPolicies: PersistedEgressPolicy;
  unfulfilledInsights: PersistedScopedFlag;
  externalSlackParticipants: PersistedScopedFlag;
  channelHeaderPin: PersistedScopedFlag;
  baseModels: PersistedBaseModel;
  orgAmbient: PersistedScopedFlag;
  interactiveFastMode: PersistedScopedFlag;
  individualModelAuth: PersistedModelAccount;
  webuiModels: ScopedRow<"ids", string[]>;
  ackEmoji: ScopedRow<"names", string[]>;
  slackEmojiCatalog: PersistedSlackEmojiCatalog;
  branding: ScopedRow<"branding", OrgBranding>;
  browseMaxSteps: ScopedRow<"steps", number>;
  browseModels: ScopedRow<"modelId", string>;
  autoFlaggerConfigs: PersistedAutoFlaggerConfig;
  deploymentIdentity: PersistedDeploymentIdentity;
}
type SettingTable = Exclude<
  keyof ConfigRecords,
  | "connectorClients"
  | "instructions"
  | "instructionsHistory"
  | "approvalGrantModes"
  | "baseModels"
  | "slackEmojiCatalog"
  | "deploymentIdentity"
>;

interface ScopeSettingValues {
  commandPolicy: CommandPolicy | null;
  egress: EgressPolicy | null;
  unfulfilledInsights: boolean;
  externalSlackParticipants: boolean;
  channelHeaderPin: boolean;
  orgAmbient: boolean;
  interactiveFastMode: boolean;
  individualModelAuth: boolean;
  webuiModels: string[] | null;
  ackEmoji: string[] | null;
  branding: OrgBranding | null;
  browseMaxSteps: number | null;
  browseModel: string | null;
  autoFlagger: AutoFlaggerConfig | null;
}
export type ScopeSettingName = keyof ScopeSettingValues;
export type ScopeSettingValue<K extends ScopeSettingName> = NonNullable<ScopeSettingValues[K]>;

interface ScopeSettingSpec<V> {
  table: SettingTable;
  target: "org" | "any";
  orgOnly?: true;
  inherit?: "fallback" | "any";
  orgDefault?: V;
  normalize?: (value: V) => V | null;
}

const emptyAsNull = (items: string[]): string[] | null => (items.length ? items : null);

export const SCOPE_SETTINGS: { [K in ScopeSettingName]: ScopeSettingSpec<ScopeSettingValue<K>> } = {
  commandPolicy: { table: "commandPolicies", target: "any", orgDefault: defaultOrgPolicy() },
  egress: { table: "egressPolicies", target: "any", orgDefault: { allowedHosts: [], deniedHosts: [] } },
  unfulfilledInsights: { table: "unfulfilledInsights", target: "any", inherit: "any" },
  externalSlackParticipants: { table: "externalSlackParticipants", target: "org", inherit: "any" },
  channelHeaderPin: { table: "channelHeaderPin", target: "org", inherit: "fallback", orgDefault: false },
  orgAmbient: { table: "orgAmbient", target: "org", orgOnly: true, orgDefault: true },
  interactiveFastMode: { table: "interactiveFastMode", target: "org", orgOnly: true, orgDefault: false },
  individualModelAuth: { table: "individualModelAuth", target: "org", orgOnly: true, orgDefault: false },
  webuiModels: { table: "webuiModels", target: "org", normalize: emptyAsNull },
  ackEmoji: { table: "ackEmoji", target: "org", normalize: emptyAsNull },
  branding: { table: "branding", target: "org" },
  browseMaxSteps: { table: "browseMaxSteps", target: "org" },
  browseModel: { table: "browseModels", target: "org" },
  autoFlagger: { table: "autoFlaggerConfigs", target: "org", orgOnly: true },
};

type Queue = ReturnType<typeof createKeyedQueue<string>>;

function notifier(label: string) {
  const listeners = new Set<(id: ScopeId) => void>();
  return {
    add: (listener: (id: ScopeId) => void) => void listeners.add(listener),
    note(id: ScopeId) {
      for (const listener of listeners) {
        try {
          listener(id);
        } catch (e) {
          reportFailure(`config: ${label} listener`, e);
        }
      }
    },
  };
}

function scopeSetting<R extends { scopeId: ScopeId }, T>(
  org: ScopeId,
  queue: Queue,
  name: string,
  rows: TypedTable<R>,
  read: (row: R) => T,
  toRow: (id: ScopeId, value: T) => R,
  orgOnly = false,
) {
  const cache = new Map<ScopeId, T>();
  const load = (id: ScopeId, row: R | null) => (row ? cache.set(id, read(row)) : cache.delete(id));
  const refresh = async (id: ScopeId) => {
    if (!orgOnly || id === org) load(id, await rows.get(id));
  };
  return {
    rows,
    refresh,
    reload: (id: ScopeId) => queue(`${name}:${id}`, () => refresh(id)),
    get: (id: ScopeId) => cache.get(id),
    durable: async (id: ScopeId) => {
      const row = await rows.get(id);
      return row ? read(row) : undefined;
    },
    set: (id: ScopeId, value: T | null) =>
      queue(`${name}:${id}`, async () => {
        const row = value === null ? null : toRow(id, value);
        if (row) await rows.put(id, row);
        else await rows.delete(id);
        load(id, row);
      }),
    async hydrate() {
      if (orgOnly) await refresh(org);
      else for (const row of await rows.all()) load(row.scopeId, row);
    },
  };
}

function createScopeSettings(org: ScopeId, tables: ConfigTables<ConfigRecords>, queue: Queue) {
  const field = <N extends SettingTable | "approvalGrantModes", K extends Exclude<keyof ConfigRecords[N], "scopeId">>(
    name: N,
    key: K,
    orgOnly = false,
  ) =>
    scopeSetting(
      org,
      queue,
      name,
      tables[name] as TypedTable<ConfigRecords[N]>,
      (row) => row[key],
      (id, value: ConfigRecords[N][K]) => ({ scopeId: id, [key]: value }) as ConfigRecords[N],
      orgOnly,
    );
  return {
    commandPolicies: field("commandPolicies", "policy"),
    approvalGrantModes: field("approvalGrantModes", "modes"),
    egressPolicies: field("egressPolicies", "policy"),
    unfulfilledInsights: field("unfulfilledInsights", "on"),
    externalSlackParticipants: field("externalSlackParticipants", "on"),
    channelHeaderPin: field("channelHeaderPin", "on"),
    orgAmbient: field("orgAmbient", "on", true),
    interactiveFastMode: field("interactiveFastMode", "on", true),
    individualModelAuth: field("individualModelAuth", "on", true),
    webuiModels: field("webuiModels", "ids"),
    ackEmoji: field("ackEmoji", "names"),
    branding: field("branding", "branding"),
    browseMaxSteps: field("browseMaxSteps", "steps"),
    browseModels: field("browseModels", "modelId"),
    autoFlaggerConfigs: scopeSetting(
      org,
      queue,
      "autoFlaggerConfigs",
      tables.autoFlaggerConfigs,
      ({ modelId, rubric }): AutoFlaggerConfig => ({ modelId, rubric }),
      (id, config) => ({ scopeId: id, ...config }),
      true,
    ),
  } satisfies Record<SettingTable | "approvalGrantModes", unknown>;
}

const DEFAULT_APPROVAL_GRANT_MODES: ApprovalGrantModes = { session: true, always: true };
const composeApprovalGrantModes = (orgModes: ApprovalGrantModes, scope?: ApprovalGrantModes): ApprovalGrantModes => ({
  session: orgModes.session && (scope?.session ?? true),
  always: orgModes.always && (scope?.always ?? true),
});

function settingsApi(org: ScopeId, settings: ReturnType<typeof createScopeSettings>) {
  type Access = {
    get(id: ScopeId): unknown;
    durable(id: ScopeId): Promise<unknown>;
    set(id: ScopeId, value: unknown): Promise<void>;
  };
  const access = (name: ScopeSettingName) =>
    (settings as unknown as Record<string, Access>)[SCOPE_SETTINGS[name].table]!;
  const resolve = (name: ScopeSettingName, id: ScopeId, own: unknown, orgValue: () => unknown): unknown => {
    const { inherit, orgDefault } = SCOPE_SETTINGS[name];
    if (inherit === "any") return Boolean(orgValue()) || Boolean(own);
    if (own !== undefined) return own;
    if (id === org) return orgDefault ?? null;
    return inherit === "fallback" ? (orgValue() ?? orgDefault ?? null) : null;
  };
  const headerPin = notifier("channel-header-pin");
  const modelAuth = settings.individualModelAuth;
  return {
    setting: <K extends ScopeSettingName>(name: K, id: ScopeId = org) =>
      resolve(name, id, access(name).get(id), () => access(name).get(org)) as ScopeSettingValues[K],
    async settingDurable<K extends ScopeSettingName>(name: K, id: ScopeId = org) {
      const { inherit } = SCOPE_SETTINGS[name];
      const stored = access(name);
      if (inherit === "any" && id !== org && (await stored.durable(org))) return true as ScopeSettingValues[K];
      const own = await stored.durable(id);
      const orgValue =
        inherit === "fallback" && own === undefined && id !== org ? await stored.durable(org) : undefined;
      return resolve(name, id, own, () => orgValue) as ScopeSettingValues[K];
    },
    settingOwnDurable: async <K extends ScopeSettingName>(name: K, id: ScopeId) =>
      ((await access(name).durable(id)) ?? null) as ScopeSettingValue<K> | null,
    async setSetting<K extends ScopeSettingName>(name: K, value: ScopeSettingValue<K> | null, id: ScopeId = org) {
      const { normalize } = SCOPE_SETTINGS[name];
      await access(name).set(id, value !== null && normalize ? normalize(value as never) : value);
      if (name === "channelHeaderPin") headerPin.note(id);
    },
    getApprovalGrantModes(id: ScopeId) {
      const orgModes = settings.approvalGrantModes.get(org) ?? DEFAULT_APPROVAL_GRANT_MODES;
      if (id === org) return { ...orgModes };
      return composeApprovalGrantModes(orgModes, settings.approvalGrantModes.get(id));
    },
    async getApprovalGrantModesDurable(id: ScopeId) {
      const orgModes = (await settings.approvalGrantModes.durable(org)) ?? DEFAULT_APPROVAL_GRANT_MODES;
      if (id === org) return { ...orgModes };
      return composeApprovalGrantModes(orgModes, await settings.approvalGrantModes.durable(id));
    },
    setApprovalGrantModes: (id: ScopeId, modes: ApprovalGrantModes) =>
      settings.approvalGrantModes.set(id, { session: !!modes.session, always: !!modes.always }),
    onChannelHeaderPinChanged: headerPin.add,
    async getIndividualModelAuthDurable(principalId?: string) {
      if (await modelAuth.durable(org)) return true;
      return principalId ? ((await modelAuth.durable(scopeId("personal", principalId))) ?? false) : false;
    },
    async getModelAccountDurable(principalId: string): Promise<ModelAccount> {
      const row = await modelAuth.rows.get(scopeId("personal", principalId));
      if (row?.on) return row.provider ?? "personal";
      return (await modelAuth.durable(org)) ? "personal" : "company";
    },
    async setPersonalModelAuth(principalId: string, on: boolean, provider?: "anthropic" | "openai") {
      const id = scopeId("personal", principalId);
      await modelAuth.rows.put(id, { scopeId: id, on, ...(on && provider ? { provider } : {}) });
    },
  };
}

const runtimeSelection = (row: PersistedBaseModel | null | undefined): ScopedRuntimeSelection | null => {
  if (row?.orgRevision === undefined || !row.modelId) return null;
  return {
    modelId: row.modelId,
    orgRevision: row.orgRevision,
    ...(row.revision !== undefined ? { revision: row.revision } : {}),
    ...(row.effortLevel !== undefined ? { effortLevel: row.effortLevel } : {}),
    ...(row.fastMode !== undefined ? { fastMode: row.fastMode } : {}),
  };
};

function createRuntimeConfig(org: ScopeId, rows: TypedTable<PersistedBaseModel>, queue: Queue) {
  const cache = new Map<ScopeId, PersistedBaseModel>();
  const changed = notifier("runtime-selection");
  const cacheRow = (id: ScopeId, row: PersistedBaseModel | null): void => {
    if (row) cache.set(id, row);
    else cache.delete(id);
  };
  const purposeFields = (row: PersistedBaseModel | null) => ({
    ...(row?.embeddingModelId ? { embeddingModelId: row.embeddingModelId } : {}),
    ...(row?.cronRuntime ? { cronRuntime: row.cronRuntime } : {}),
    ...(row?.subagentRuntime ? { subagentRuntime: row.subagentRuntime } : {}),
    ...(row?.fallbackRuntime ? { fallbackRuntime: row.fallbackRuntime } : {}),
  });
  const setOrgField = <K extends keyof PersistedBaseModel>(key: K, value: PersistedBaseModel[K] | undefined) =>
    queue(`model:${org}`, async () => {
      const saved = await rows.modify(org, (current) => {
        const row: PersistedBaseModel = { ...current, scopeId: org };
        if (value) row[key] = value;
        else delete row[key];
        return Object.keys(row).length > 1 ? row : null;
      });
      cacheRow(org, saved);
    });
  const setPurposeRuntime = (purpose: RuntimePurpose, selection?: RuntimeSelection) =>
    setOrgField(`${purpose}Runtime`, selection ? { ...selection } : undefined);
  const api = {
    getPurposeRuntime: (purpose: RuntimePurpose) => {
      const selection = cache.get(org)?.[`${purpose}Runtime`];
      return selection ? { ...selection } : undefined;
    },
    getPurposeRuntimeDurable: async (purpose: RuntimePurpose) => {
      const selection = (await rows.get(org))?.[`${purpose}Runtime`];
      return selection ? { ...selection } : undefined;
    },
    setPurposeRuntime,
    clearPurposeRuntime: (purpose: RuntimePurpose) => setPurposeRuntime(purpose),
    getRuntimeSelection: (id: ScopeId) => runtimeSelection(cache.get(id)),
    async setRuntimeSelection(id: ScopeId, selection: RuntimeSelection | null) {
      await queue(`model:${id}`, async () => {
        const orgRevision = id === org || selection === null ? 0 : ((await rows.get(org))?.revision ?? 0);
        const saved = await rows.modify(id, (row) => {
          const kept = { scopeId: id, ...(id === org ? purposeFields(row) : {}) };
          if (selection === null) return Object.keys(kept).length > 1 ? kept : null;
          if (id !== org) return { ...kept, ...selection, orgRevision };
          const revision = (row?.revision ?? 0) + 1;
          return { ...kept, ...selection, revision, orgRevision: revision };
        });
        cacheRow(id, saved);
      });
      changed.note(id);
    },
    async acknowledgeRuntimeSelection(id: ScopeId) {
      if (id === org) return;
      await queue(`model:${id}`, async () => {
        const orgRevision = (await rows.get(org))?.revision ?? 0;
        const saved = await rows.modify(id, (row) => (row ? { ...row, orgRevision } : null));
        if (saved) cache.set(id, saved);
      });
    },
    onRuntimeSelectionChanged: changed.add,
    getRuntimeSelectionDurable: async (id: ScopeId) => runtimeSelection(await rows.get(id)),
    getEmbeddingModelDurable: async () => (await rows.get(org))?.embeddingModelId ?? null,
    setEmbeddingModel: (modelId: string | null) => setOrgField("embeddingModelId", modelId ?? undefined),
  };
  return {
    api,
    hydrate: async () => {
      for (const r of await rows.all()) cache.set(r.scopeId, r);
    },
    refresh: async (id: ScopeId) => cacheRow(id, await rows.get(id)),
  };
}

function connectorClientsApi(rows: TypedTable<StoredConnectorClient>, secretKey: Buffer | string) {
  const connectorKey = deriveConnectorKey(secretKey, "connector-clients");
  const key = (id: ScopeId, provider: string) => `${id}|${provider}`;
  const optional = (rec: Omit<ConnectorClientInput, "clientId" | "clientSecret">) => ({
    ...(rec.scopes ? { scopes: rec.scopes } : {}),
    ...(rec.redirectAllowlist ? { redirectAllowlist: rec.redirectAllowlist } : {}),
    ...(rec.consentMode ? { consentMode: rec.consentMode } : {}),
    ...(rec.hostedDomain ? { hostedDomain: rec.hostedDomain } : {}),
  });
  return {
    async setConnectorClient(id: ScopeId, provider: string, input: ConnectorClientInput) {
      await rows.put(key(id, provider), {
        scopeId: id,
        provider,
        clientId: input.clientId,
        secretEnc: encryptSecret(input.clientSecret, connectorKey),
        ...optional(input),
        enabled: input.enabled !== false,
        ...(input.updatedBy ? { updatedBy: input.updatedBy } : {}),
        updatedAt: Date.now(),
      });
    },
    listConnectorClients: async (id: ScopeId) => (await rows.where("scopeId", id)).map(toPublicConnectorClient),
    deleteConnectorClient: (id: ScopeId, provider: string) => rows.delete(key(id, provider)),
    async getConnectorClientSecret(id: ScopeId, provider: string): Promise<DecryptedConnectorClient | null> {
      const rec = await rows.get(key(id, provider));
      if (!rec) return null;
      return {
        clientId: rec.clientId,
        clientSecret: decryptSecret(rec.secretEnc, connectorKey),
        ...optional(rec),
        enabled: rec.enabled,
      };
    },
  };
}

function createTenantConfigStore(
  tables: ConfigTables<ConfigRecords>,
  queue: Queue,
  connectorClients: ReturnType<typeof connectorClientsApi>,
) {
  const { orgId, orgScope: org } = tenant();
  const settings = createScopeSettings(org, tables, queue);
  const allSettings = Object.values(settings);
  const instructions = createInstructions(org, tables.instructions, tables.instructionsHistory, queue);
  const runtime = createRuntimeConfig(org, tables.baseModels, queue);
  let hydrated: Promise<void> | null = null;
  const store: ScopedConfigStore = {
    ...settingsApi(org, settings),
    ...instructions.api,
    ...runtime.api,
    ...connectorClients,
    async refreshSecurity(ids) {
      await Promise.all(
        ids.flatMap((id) => [
          instructions.refreshSecurity(id),
          settings.commandPolicies.reload(id),
          settings.egressPolicies.reload(id),
        ]),
      );
    },
    async setSlackEmojiCatalog(id, emoji) {
      await queue(`slackEmojiCatalog:${id}`, () =>
        tables.slackEmojiCatalog.put(id, { scopeId: id, emoji, updatedAt: Date.now() }),
      );
    },
    getSlackEmojiCatalogDurable: (id) => tables.slackEmojiCatalog.get(id),
    hydrate() {
      if (!hydrated) {
        const pending = (async () => {
          const identity = await tables.deploymentIdentity.insertOrGet("singleton", { orgId });
          if (identity.orgId !== orgId) throw new Error(`database belongs to org ${identity.orgId}, not ${orgId}`);
          await instructions.hydrate();
          await runtime.hydrate();
          await Promise.all(allSettings.map((setting) => setting.hydrate()));
        })();
        hydrated = pending;
        pending.catch(() => {
          if (hydrated === pending) hydrated = null;
        });
      }
      return hydrated;
    },
    async refreshScope(id) {
      await Promise.all([
        instructions.refresh(id),
        runtime.refresh(id),
        ...allSettings.map((setting) => setting.refresh(id)),
      ]);
    },
  };
  return store;
}

export function createConfigStore(opts: {
  databaseUrl: string;
  connectorSecretKey: Buffer | string;
}): ScopedConfigStore {
  const tables = openConfigTables<ConfigRecords>(opts.databaseUrl);
  const queue = createKeyedQueue();
  const connectorClients = connectorClientsApi(tables.connectorClients, opts.connectorSecretKey);
  const stores = perTenant(() => createTenantConfigStore(tables, queue, connectorClients));
  const bound: Record<string, unknown> = {};
  for (const key of Object.keys(stores())) {
    bound[key] = (...args: unknown[]) =>
      (stores() as unknown as Record<string, (...args: unknown[]) => unknown>)[key]!(...args);
  }
  return bound as unknown as ScopedConfigStore;
}
