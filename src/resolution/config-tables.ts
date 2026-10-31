import type { ApprovalGrantModes, CommandPolicy, EgressPolicy, ScopeId } from "../types.ts";
import type { SecurityPosture } from "../security/security-posture.ts";
import type { SharingPosture } from "./sharing-posture.ts";
import type { StoredConnectorClient } from "../connectors/connector-client-store.ts";

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
  modelId: string;
  effortLevel?: string;
  fastMode?: boolean;
}

export interface AutoFlaggerConfig {
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
  autoFlagger?: AutoFlaggerConfig;
}

export interface ConfigTables {
  readonly fresh?: boolean;
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
