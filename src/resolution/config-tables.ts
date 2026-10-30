import type { ApprovalGrantModes, CommandPolicy, EgressPolicy, ScopeId } from "../types.ts";
import type { SecurityPosture } from "../security/security-posture.ts";
import type { SharingPosture } from "./sharing-posture.ts";
import type { StoredConnectorClient } from "../connectors/connector-client-store.ts";
import { currentTenant } from "../tenants/context.ts";

export interface OrgBranding {
  accent?: string;
  mark?: string;
  markUrl?: string;
  selfLabel?: string;
  orgName?: string;
}

export type ModelAccount = "company" | "personal" | "anthropic" | "openai";
export type RuntimePurpose = "cron" | "subagent" | "fallback";

export interface RuntimeSelection {
  harnessId: string;
  modelId: string;
  effortLevel?: string;
  fastMode?: boolean;
}

export interface AutoFlaggerConfig {
  harnessId: string;
  modelId: string;
  rubric: string;
}

export interface ScopeSettings {
  commandPolicy?: CommandPolicy;
  securityPosture?: SecurityPosture;
  sharingPosture?: SharingPosture;
  approvalGrantModes?: ApprovalGrantModes;
  egress?: EgressPolicy;
  unfulfilledInsights?: boolean;
  externalSlackParticipants?: boolean;
  channelHeaderPin?: boolean;
  webuiModels?: string[];
  ackEmoji?: string[];
  branding?: OrgBranding;
  browseMaxSteps?: number;
  browseModel?: string;
  modelAccount?: Exclude<ModelAccount, "company">;
  modelId?: string;
  harnessId?: string;
  effortLevel?: string;
  fastMode?: boolean;
  revision?: number;
  orgRevision?: number;
  orgAmbient?: boolean;
  interactiveFastMode?: boolean;
  individualModelAuth?: boolean;
}

export interface SoulRevision {
  scopeId: ScopeId;
  content: string;
  version: number;
  updatedAt: number;
  updatedBy?: string;
}

export interface SlackEmojiCatalog {
  scopeId: ScopeId;
  emoji: Record<string, string>;
  updatedAt: number;
}

export interface OperatorSettings {
  embeddingModelId?: string;
  approvedHarnesses?: string[];
  autoFlagger?: AutoFlaggerConfig;
}

export interface ConfigTables {
  readonly persistent: boolean;
  scopeSettings(ids?: readonly ScopeId[]): Promise<Array<[ScopeId, ScopeSettings]>>;
  scopeSetting(id: ScopeId): Promise<ScopeSettings | null>;
  updateScopeSetting(id: ScopeId, fn: (current: ScopeSettings) => ScopeSettings): Promise<ScopeSettings>;
  soulRevisions(perScope: number, ids?: readonly ScopeId[]): Promise<SoulRevision[]>;
  appendSoul(revision: SoulRevision, expectedVersion: number, baseVersion: number): Promise<boolean>;
  purposeRuntimes(): Promise<Partial<Record<RuntimePurpose, RuntimeSelection>>>;
  setPurposeRuntime(purpose: RuntimePurpose, selection: RuntimeSelection | null): Promise<void>;
  connectorClients(id: ScopeId): Promise<StoredConnectorClient[]>;
  connectorClient(id: ScopeId, provider: string): Promise<StoredConnectorClient | null>;
  putConnectorClient(client: StoredConnectorClient): Promise<void>;
  deleteConnectorClient(id: ScopeId, provider: string): Promise<void>;
  slackEmojiCatalog(id: ScopeId): Promise<SlackEmojiCatalog | null>;
  putSlackEmojiCatalog(catalog: SlackEmojiCatalog): Promise<void>;
  operatorSettings(): Promise<OperatorSettings>;
  updateOperatorSettings(fn: (current: OperatorSettings) => OperatorSettings): Promise<OperatorSettings>;
  close?(): Promise<void>;
}

export const definedOnly = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

interface MemoryTenant {
  scopes: Map<ScopeId, ScopeSettings>;
  souls: Map<ScopeId, SoulRevision[]>;
  purposes: Map<RuntimePurpose, RuntimeSelection>;
  connectors: Map<string, StoredConnectorClient>;
  emoji: Map<ScopeId, SlackEmojiCatalog>;
}

export function createMemoryConfigTables(): ConfigTables {
  const tenants = new Map<string, MemoryTenant>();
  let operator: OperatorSettings = {};
  const data = (): MemoryTenant => {
    const id = currentTenant();
    let found = tenants.get(id);
    if (!found) {
      found = { scopes: new Map(), souls: new Map(), purposes: new Map(), connectors: new Map(), emoji: new Map() };
      tenants.set(id, found);
    }
    return found;
  };
  const connectorKey = (id: ScopeId, provider: string) => `${id}|${provider}`;
  return {
    persistent: false,
    scopeSettings: async (ids) =>
      [...data().scopes].filter(([id]) => !ids || ids.includes(id)).map(([id, row]) => [id, structuredClone(row)]),
    async scopeSetting(id) {
      const row = data().scopes.get(id);
      return row ? structuredClone(row) : null;
    },
    async updateScopeSetting(id, fn) {
      const scopes = data().scopes;
      const next = definedOnly(fn(structuredClone(scopes.get(id) ?? {})));
      scopes.set(id, structuredClone(next));
      return next;
    },
    async soulRevisions(perScope, ids) {
      const souls = data().souls;
      const scopes = ids ?? [...souls.keys()];
      return scopes.flatMap((scope) => (souls.get(scope) ?? []).slice(0, perScope).map((r) => ({ ...r })));
    },
    async appendSoul(revision, expectedVersion, baseVersion) {
      const souls = data().souls;
      const history = souls.get(revision.scopeId) ?? [];
      if (Math.max(history[0]?.version ?? 0, baseVersion) !== expectedVersion) return false;
      if (history.some((r) => r.version === revision.version)) return false;
      souls.set(revision.scopeId, [{ ...revision }, ...history]);
      return true;
    },
    purposeRuntimes: async () => Object.fromEntries([...data().purposes].map(([p, s]) => [p, { ...s }])),
    async setPurposeRuntime(purpose, selection) {
      if (selection) data().purposes.set(purpose, definedOnly({ ...selection }));
      else data().purposes.delete(purpose);
    },
    connectorClients: async (id) =>
      [...data().connectors.values()].filter((c) => c.scopeId === id).map((c) => structuredClone(c)),
    async connectorClient(id, provider) {
      const found = data().connectors.get(connectorKey(id, provider));
      return found ? structuredClone(found) : null;
    },
    async putConnectorClient(client) {
      data().connectors.set(connectorKey(client.scopeId, client.provider), structuredClone(client));
    },
    async deleteConnectorClient(id, provider) {
      data().connectors.delete(connectorKey(id, provider));
    },
    async slackEmojiCatalog(id) {
      const found = data().emoji.get(id);
      return found ? structuredClone(found) : null;
    },
    async putSlackEmojiCatalog(catalog) {
      data().emoji.set(catalog.scopeId, structuredClone(catalog));
    },
    operatorSettings: async () => structuredClone(operator),
    async updateOperatorSettings(fn) {
      operator = definedOnly(fn(structuredClone(operator)));
      return structuredClone(operator);
    },
  };
}
