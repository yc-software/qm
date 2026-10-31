import { tenantRootScope } from "../tenants/context.ts";
import type { ApprovalGrantModes, EgressPolicy, ScopeId } from "../types.ts";
import { scopeId } from "../types.ts";
import { defaultOrgPolicy } from "../policy/command-policy.ts";
import { errMessage } from "../util/errors.ts";
import { isHarnessId, modelSupportedByHarness } from "../model/pi-models.ts";
import { composeSecurityPosture, type SecurityPosture } from "../security/security-posture.ts";
import { composeSharingPostures, type SharingPosture } from "./sharing-posture.ts";
import {
  decryptSecret,
  encryptSecret,
  toPublicConnectorClient,
  type SecretKey,
  type StoredConnectorClient,
} from "../connectors/connector-client-store.ts";
import type {
  ConfigTables,
  OperatorSettings,
  RuntimePurpose,
  RuntimeSelection,
  ScopeSettings,
  SoulRevision,
} from "./config-tables.ts";
import { definedOnly } from "./config-tables.ts";
import type { ScopedConfigStore, ScopedRuntimeSelection } from "./config-store.ts";

export interface TenantConfig {
  scopes: Map<ScopeId, ScopeSettings>;
  souls: Map<ScopeId, SoulRevision[]>;
  purposes: Partial<Record<RuntimePurpose, RuntimeSelection>>;
}

export interface ConfigContext {
  tables: ConfigTables;
  queue<T>(key: string, fn: () => Promise<T>): Promise<T>;
  scope(id: ScopeId): ScopeSettings | undefined;
  own(id: ScopeId): Promise<ScopeSettings>;
  writeScope(id: ScopeId, fn: (current: ScopeSettings) => ScopeSettings): Promise<ScopeSettings>;
  put<K extends keyof ScopeSettings>(id: ScopeId, key: K, value: ScopeSettings[K] | null): Promise<void>;
  cached(): TenantConfig;
  loaded(): TenantConfig | undefined;
  reloadSouls(id: ScopeId): Promise<void>;
  markWritten(id: ScopeId): void;
  operator: { settings: OperatorSettings };
  defaultSecurityPosture: SecurityPosture;
  defaultSharingPosture: SharingPosture;
  connectorKey: SecretKey;
}

type Methods<K extends keyof ScopedConfigStore> = Pick<ScopedConfigStore, K>;

const DEFAULT_ORG_SOUL =
  "You are a helpful internal assistant for this organization. Be concise, accurate, and respect data boundaries: never reveal information to people who are not party to the current conversation.";

export function soulMethods(
  ctx: ConfigContext,
): Methods<"getSoul" | "setSoul" | "setSoulIfVersion" | "soulVersion" | "soulHistory"> {
  const { tables } = ctx;
  const baseVersion = (id: ScopeId) => (id === tenantRootScope() ? 1 : 0);
  const current = (id: ScopeId) => ctx.cached().souls.get(id)?.[0];
  const revision = (id: ScopeId, content: string, version: number, updatedBy?: string): SoulRevision => ({
    scopeId: id,
    content,
    version,
    updatedAt: Date.now(),
    ...(updatedBy ? { updatedBy } : {}),
  });
  return {
    getSoul: (id) => current(id)?.content ?? (id === tenantRootScope() ? DEFAULT_ORG_SOUL : null),
    soulVersion: (id) => current(id)?.version ?? baseVersion(id),
    soulHistory: (id) => (ctx.cached().souls.get(id) ?? []).map((r) => ({ ...r })),
    setSoul(id, content, updatedBy) {
      return ctx.queue(`scope:${id}`, async () => {
        for (;;) {
          const [latest] = await tables.soulRevisions(1, [id]);
          const expected = Math.max(latest?.version ?? 0, baseVersion(id));
          if (await tables.appendSoul(revision(id, content, expected + 1, updatedBy), expected, baseVersion(id))) {
            ctx.markWritten(id);
            await ctx.reloadSouls(id);
            return expected + 1;
          }
        }
      });
    },
    setSoulIfVersion(id, expectedVersion, content, updatedBy) {
      return ctx.queue(`scope:${id}`, async () => {
        const next = revision(id, content, expectedVersion + 1, updatedBy);
        if (!(await tables.appendSoul(next, expectedVersion, baseVersion(id)))) return null;
        ctx.markWritten(id);
        await ctx.reloadSouls(id);
        return next.version;
      });
    },
  };
}

const DEFAULT_APPROVAL_GRANT_MODES: ApprovalGrantModes = { session: true, always: true };
const composeApprovalGrantModes = (orgModes: ApprovalGrantModes, scope?: ApprovalGrantModes): ApprovalGrantModes => ({
  session: orgModes.session && (scope?.session ?? true),
  always: orgModes.always && (scope?.always ?? true),
});

export function policyMethods(
  ctx: ConfigContext,
): Methods<
  | "getCommandPolicy"
  | "setCommandPolicy"
  | "getSecurityPostureDurable"
  | "getSecurityPostureOwnDurable"
  | "setSecurityPosture"
  | "getSharingPostureDurable"
  | "getSharingPostureOwnDurable"
  | "resolveSharingPostureDurable"
  | "setSharingPosture"
  | "clearSharingPosture"
  | "getApprovalGrantModes"
  | "getApprovalGrantModesDurable"
  | "setApprovalGrantModes"
  | "getEgress"
  | "setEgress"
> {
  const orgDefaultPolicy = defaultOrgPolicy();
  const orgDefaultEgress: EgressPolicy = { allowedHosts: [], deniedHosts: [] };
  const orgSecurity = async () => (await ctx.own(tenantRootScope())).securityPosture ?? ctx.defaultSecurityPosture;
  const orgSharing = async () => (await ctx.own(tenantRootScope())).sharingPosture ?? ctx.defaultSharingPosture;
  return {
    getCommandPolicy: (id) => ctx.scope(id)?.commandPolicy ?? (id === tenantRootScope() ? orgDefaultPolicy : null),
    setCommandPolicy: (id, policy) => ctx.put(id, "commandPolicy", policy),
    async getSecurityPostureDurable(id) {
      const orgPosture = await orgSecurity();
      return id === tenantRootScope()
        ? orgPosture
        : composeSecurityPosture(orgPosture, (await ctx.own(id)).securityPosture);
    },
    getSecurityPostureOwnDurable: async (id) => (await ctx.own(id)).securityPosture ?? null,
    async setSecurityPosture(id, posture) {
      await ctx.put(
        id,
        "securityPosture",
        id === tenantRootScope() ? posture : composeSecurityPosture(await orgSecurity(), posture),
      );
    },
    async getSharingPostureDurable(id) {
      const orgPosture = await orgSharing();
      return id === tenantRootScope()
        ? orgPosture
        : composeSharingPostures(orgPosture, [(await ctx.own(id)).sharingPosture]);
    },
    getSharingPostureOwnDurable: async (id) => (await ctx.own(id)).sharingPosture ?? null,
    async resolveSharingPostureDurable(personalId, targetId) {
      const [orgRow, personalRow, targetRow] = await Promise.all(
        [tenantRootScope(), personalId, targetId].map((id) => ctx.own(id)),
      );
      return composeSharingPostures(orgRow!.sharingPosture ?? ctx.defaultSharingPosture, [
        personalId === tenantRootScope() ? undefined : personalRow!.sharingPosture,
        targetId === tenantRootScope() || targetId === personalId ? undefined : targetRow!.sharingPosture,
      ]);
    },
    setSharingPosture: (id, posture) => ctx.put(id, "sharingPosture", posture),
    clearSharingPosture: (id) => ctx.put(id, "sharingPosture", null),
    getApprovalGrantModes(id) {
      const orgModes = ctx.scope(tenantRootScope())?.approvalGrantModes ?? DEFAULT_APPROVAL_GRANT_MODES;
      return id === tenantRootScope()
        ? { ...orgModes }
        : composeApprovalGrantModes(orgModes, ctx.scope(id)?.approvalGrantModes);
    },
    async getApprovalGrantModesDurable(id) {
      const orgModes = (await ctx.own(tenantRootScope())).approvalGrantModes ?? DEFAULT_APPROVAL_GRANT_MODES;
      if (id === tenantRootScope()) return { ...orgModes };
      return composeApprovalGrantModes(orgModes, (await ctx.own(id)).approvalGrantModes);
    },
    setApprovalGrantModes: (id, modes) =>
      ctx.put(id, "approvalGrantModes", { session: !!modes.session, always: !!modes.always }),
    getEgress: (id) => ctx.scope(id)?.egress ?? (id === tenantRootScope() ? orgDefaultEgress : null),
    setEgress: (id, policy) => ctx.put(id, "egress", policy),
  };
}

const RUNTIME_FIELDS = ["modelId", "harnessId", "effortLevel", "fastMode", "revision", "orgRevision"] as const;

const withoutRuntime = (row: ScopeSettings): ScopeSettings =>
  Object.fromEntries(
    Object.entries(row).filter(([key]) => !(RUNTIME_FIELDS as readonly string[]).includes(key)),
  ) as ScopeSettings;

const selectionFields = (s: RuntimeSelection): RuntimeSelection =>
  definedOnly({ harnessId: s.harnessId, modelId: s.modelId, effortLevel: s.effortLevel, fastMode: s.fastMode });

function runtimeSelection(row: ScopeSettings | undefined | null): ScopedRuntimeSelection | null {
  if (!row?.harnessId || !row.modelId) return null;
  return definedOnly({
    harnessId: row.harnessId,
    modelId: row.modelId,
    orgRevision: row.orgRevision ?? 0,
    revision: row.revision,
    effortLevel: row.effortLevel,
    fastMode: row.fastMode,
  });
}

function notifier(label: string) {
  const listeners = new Set<(id: ScopeId) => void>();
  return {
    add: (listener: (id: ScopeId) => void) => void listeners.add(listener),
    note(id: ScopeId) {
      for (const listener of listeners) {
        try {
          listener(id);
        } catch (e) {
          console.error(`[config] ${label} listener failed:`, errMessage(e));
        }
      }
    },
  };
}

export function runtimeMethods(
  ctx: ConfigContext,
): Methods<
  | "getPurposeRuntime"
  | "getPurposeRuntimeDurable"
  | "setPurposeRuntime"
  | "clearPurposeRuntime"
  | "getBaseModel"
  | "setBaseModel"
  | "getRuntimeSelection"
  | "setRuntimeSelection"
  | "acknowledgeRuntimeSelection"
  | "getRuntimeSelectionDurable"
  | "onRuntimeSelectionChanged"
  | "getBaseModelOwnDurable"
  | "getBaseModelDurable"
> {
  const { tables } = ctx;
  const changed = notifier("runtime-selection");
  const setPurpose = (purpose: RuntimePurpose, selection: RuntimeSelection | null) =>
    ctx.queue(`purpose:${purpose}`, async () => {
      const value = selection ? selectionFields(selection) : null;
      await tables.setPurposeRuntime(purpose, value);
      const target = ctx.loaded();
      if (!target) return;
      if (value) target.purposes[purpose] = value;
      else delete target.purposes[purpose];
    });
  return {
    getPurposeRuntime: (purpose) => {
      const selection = ctx.cached().purposes[purpose];
      return selection ? { ...selection } : undefined;
    },
    getPurposeRuntimeDurable: async (purpose) => (await tables.purposeRuntimes())[purpose],
    setPurposeRuntime: (purpose, selection) => setPurpose(purpose, selection),
    clearPurposeRuntime: (purpose) => setPurpose(purpose, null),
    getBaseModel: (id) => ctx.scope(id)?.modelId ?? null,
    async setBaseModel(id, modelId) {
      await ctx.writeScope(id, (row) => {
        if (modelId === null) return withoutRuntime(row);
        if (row.harnessId && isHarnessId(row.harnessId) && !modelSupportedByHarness(modelId, row.harnessId)) return row;
        return { ...row, modelId };
      });
      changed.note(id);
    },
    getRuntimeSelection: (id) => runtimeSelection(ctx.scope(id)),
    async setRuntimeSelection(id, selection) {
      if (selection === null) await ctx.writeScope(id, withoutRuntime);
      else if (id === tenantRootScope()) {
        await ctx.writeScope(id, (row) => {
          const revision = (row.revision ?? 0) + 1;
          return { ...withoutRuntime(row), ...selectionFields(selection), revision, orgRevision: revision };
        });
      } else {
        const orgRevision = (await ctx.own(tenantRootScope())).revision ?? 0;
        await ctx.writeScope(id, (row) => ({ ...withoutRuntime(row), ...selectionFields(selection), orgRevision }));
      }
      changed.note(id);
    },
    async acknowledgeRuntimeSelection(id) {
      if (id === tenantRootScope()) return;
      const orgRevision = (await ctx.own(tenantRootScope())).revision ?? 0;
      await ctx.writeScope(id, (row) =>
        RUNTIME_FIELDS.some((key) => row[key] !== undefined) ? { ...row, orgRevision } : row,
      );
    },
    getRuntimeSelectionDurable: async (id) => runtimeSelection(await ctx.own(id)),
    onRuntimeSelectionChanged: changed.add,
    getBaseModelOwnDurable: async (id) => (await ctx.own(id)).modelId ?? null,
    getBaseModelDurable: async (id) =>
      (await ctx.own(id)).modelId ??
      (id === tenantRootScope() ? null : ((await ctx.own(tenantRootScope())).modelId ?? null)),
  };
}

type PreferenceMethods =
  | "getUnfulfilledInsights"
  | "setUnfulfilledInsights"
  | "getExternalSlackParticipants"
  | "setExternalSlackParticipants"
  | "getExternalSlackParticipantsDurable"
  | "getChannelHeaderPin"
  | "setChannelHeaderPin"
  | "getChannelHeaderPinDurable"
  | "getChannelHeaderPinOverrideDurable"
  | "getChannelHeaderPinDefaultDurable"
  | "onChannelHeaderPinChanged"
  | "getOrgAmbient"
  | "setOrgAmbient"
  | "getOrgAmbientDurable"
  | "getInteractiveFastMode"
  | "setInteractiveFastMode"
  | "getInteractiveFastModeDurable"
  | "getIndividualModelAuth"
  | "setIndividualModelAuth"
  | "getIndividualModelAuthDurable"
  | "setPersonalModelAuth"
  | "getModelAccountDurable"
  | "getWebuiModels"
  | "setWebuiModels"
  | "getWebuiModelsDurable"
  | "getAckEmoji"
  | "setAckEmoji"
  | "getAckEmojiDurable"
  | "setSlackEmojiCatalog"
  | "getSlackEmojiCatalogDurable"
  | "getBranding"
  | "setBranding"
  | "getBrandingDurable"
  | "getBrowseMaxSteps"
  | "setBrowseMaxSteps"
  | "getBrowseModel"
  | "setBrowseModel";

export function preferenceMethods(ctx: ConfigContext): Methods<PreferenceMethods> {
  const { tables } = ctx;
  const pinChanged = notifier("channel-header-pin");
  const either = (id: ScopeId, key: "unfulfilledInsights" | "externalSlackParticipants") =>
    (ctx.scope(tenantRootScope())?.[key] ?? false) || (ctx.scope(id)?.[key] ?? false);
  const personal = (principalId: string) => scopeId("personal", principalId);
  const list = (ids: string[] | null) => (ids?.length ? [...ids] : null);
  return {
    getUnfulfilledInsights: (id) => either(id, "unfulfilledInsights"),
    setUnfulfilledInsights: (id, on) => ctx.put(id, "unfulfilledInsights", on),
    getExternalSlackParticipants: (id) => either(id, "externalSlackParticipants"),
    setExternalSlackParticipants: (id, on) => ctx.put(id, "externalSlackParticipants", on),
    getExternalSlackParticipantsDurable: async (id) =>
      ((await ctx.own(tenantRootScope())).externalSlackParticipants ?? false) ||
      ((await ctx.own(id)).externalSlackParticipants ?? false),
    getChannelHeaderPin: (id) =>
      ctx.scope(id)?.channelHeaderPin ?? ctx.scope(tenantRootScope())?.channelHeaderPin ?? false,
    async setChannelHeaderPin(id, on) {
      await ctx.put(id, "channelHeaderPin", on);
      pinChanged.note(id);
    },
    getChannelHeaderPinDurable: async (id) =>
      (await ctx.own(id)).channelHeaderPin ??
      (id === tenantRootScope() ? false : ((await ctx.own(tenantRootScope())).channelHeaderPin ?? false)),
    getChannelHeaderPinOverrideDurable: async (id) => (await ctx.own(id)).channelHeaderPin ?? null,
    getChannelHeaderPinDefaultDurable: async () => (await ctx.own(tenantRootScope())).channelHeaderPin ?? false,
    onChannelHeaderPinChanged: pinChanged.add,
    getOrgAmbient: () => ctx.scope(tenantRootScope())?.orgAmbient ?? true,
    setOrgAmbient: (on) => ctx.put(tenantRootScope(), "orgAmbient", on),
    getOrgAmbientDurable: async () => (await ctx.own(tenantRootScope())).orgAmbient ?? true,
    getInteractiveFastMode: () => ctx.scope(tenantRootScope())?.interactiveFastMode ?? false,
    setInteractiveFastMode: (on) => ctx.put(tenantRootScope(), "interactiveFastMode", on),
    getInteractiveFastModeDurable: async () => (await ctx.own(tenantRootScope())).interactiveFastMode ?? false,
    getIndividualModelAuth: () => ctx.scope(tenantRootScope())?.individualModelAuth ?? false,
    setIndividualModelAuth: (on) => ctx.put(tenantRootScope(), "individualModelAuth", on),
    async getIndividualModelAuthDurable(principalId) {
      if ((await ctx.own(tenantRootScope())).individualModelAuth) return true;
      return principalId ? (await ctx.own(personal(principalId))).modelAccount !== undefined : false;
    },
    async getModelAccountDurable(principalId) {
      const account = (await ctx.own(personal(principalId))).modelAccount;
      if (account) return account;
      return (await ctx.own(tenantRootScope())).individualModelAuth ? "personal" : "company";
    },
    setPersonalModelAuth: (principalId, on, provider) =>
      ctx.put(personal(principalId), "modelAccount", on ? (provider ?? "personal") : null),
    getWebuiModels: (id) => ctx.scope(id)?.webuiModels ?? null,
    setWebuiModels: (id, ids) => ctx.put(id, "webuiModels", list(ids)),
    getWebuiModelsDurable: async (id) =>
      (await ctx.own(id)).webuiModels ?? (await ctx.own(tenantRootScope())).webuiModels ?? null,
    getAckEmoji: (id) => ctx.scope(id)?.ackEmoji ?? null,
    setAckEmoji: (id, names) => ctx.put(id, "ackEmoji", list(names)),
    getAckEmojiDurable: async (id) => (await ctx.own(id)).ackEmoji ?? null,
    setSlackEmojiCatalog: (id, emoji) =>
      ctx.queue(`emoji:${id}`, () => tables.putSlackEmojiCatalog({ scopeId: id, emoji, updatedAt: Date.now() })),
    getSlackEmojiCatalogDurable: (id) => tables.slackEmojiCatalog(id),
    getBranding: (id) => ctx.scope(id)?.branding ?? null,
    setBranding: (id, value) => ctx.put(id, "branding", value),
    getBrandingDurable: async (id) => (await ctx.own(id)).branding ?? null,
    getBrowseMaxSteps: (id) => ctx.scope(id)?.browseMaxSteps ?? null,
    setBrowseMaxSteps: (id, steps) => ctx.put(id, "browseMaxSteps", steps),
    getBrowseModel: (id) => ctx.scope(id)?.browseModel ?? null,
    setBrowseModel: (id, modelId) => ctx.put(id, "browseModel", modelId),
  };
}

export function operatorMethods(
  ctx: ConfigContext,
): Methods<
  | "getApprovedHarnesses"
  | "setApprovedHarnesses"
  | "getApprovedHarnessesDurable"
  | "getEmbeddingModelDurable"
  | "setEmbeddingModel"
  | "getAutoFlaggerConfig"
  | "setAutoFlaggerConfig"
> {
  const { tables, operator } = ctx;
  const update = (patch: OperatorSettings) =>
    ctx.queue("operator", async () => {
      operator.settings = await tables.updateOperatorSettings((current) => ({ ...current, ...patch }));
    });
  return {
    getApprovedHarnesses: () => (operator.settings.approvedHarnesses ? [...operator.settings.approvedHarnesses] : null),
    setApprovedHarnesses: (ids) => update({ approvedHarnesses: ids ? [...ids] : undefined }),
    getApprovedHarnessesDurable: async () => (await tables.operatorSettings()).approvedHarnesses ?? null,
    getEmbeddingModelDurable: async () => (await tables.operatorSettings()).embeddingModelId ?? null,
    setEmbeddingModel: (modelId) => update({ embeddingModelId: modelId ?? undefined }),
    getAutoFlaggerConfig: () => (operator.settings.autoFlagger ? { ...operator.settings.autoFlagger } : null),
    setAutoFlaggerConfig: (config) =>
      update({
        autoFlagger: config
          ? { harnessId: config.harnessId, modelId: config.modelId, rubric: config.rubric }
          : undefined,
      }),
  };
}

export function connectorMethods(
  ctx: ConfigContext,
): Methods<"setConnectorClient" | "listConnectorClients" | "deleteConnectorClient" | "getConnectorClientSecret"> {
  const { tables, connectorKey } = ctx;
  return {
    async setConnectorClient(id, provider, input) {
      const client: StoredConnectorClient = definedOnly({
        scopeId: id,
        provider,
        clientId: input.clientId,
        secretEnc: encryptSecret(input.clientSecret, connectorKey),
        scopes: input.scopes,
        redirectAllowlist: input.redirectAllowlist,
        consentMode: input.consentMode,
        hostedDomain: input.hostedDomain || undefined,
        enabled: input.enabled !== false,
        updatedBy: input.updatedBy || undefined,
        updatedAt: Date.now(),
      });
      await tables.putConnectorClient(client);
    },
    listConnectorClients: async (id) => (await tables.connectorClients(id)).map(toPublicConnectorClient),
    deleteConnectorClient: (id, provider) => tables.deleteConnectorClient(id, provider),
    async getConnectorClientSecret(id, provider) {
      const client = await tables.connectorClient(id, provider);
      if (!client) return null;
      return definedOnly({
        clientId: client.clientId,
        clientSecret: decryptSecret(client.secretEnc, connectorKey),
        scopes: client.scopes,
        redirectAllowlist: client.redirectAllowlist,
        consentMode: client.consentMode,
        hostedDomain: client.hostedDomain,
        enabled: client.enabled,
      });
    },
  };
}
