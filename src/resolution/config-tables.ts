import type { SpendLimit } from "../ratelimit/spend-limits.ts";
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
  spendLimit?: SpendLimit;
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
  embeddingModelId?: string;
}

export interface SoulRevision {
  scopeId: ScopeId;
  content: string;
  version: number;
  updatedAt: number;
  updatedBy?: string;
  sessionId?: string;
}

export interface SlackEmojiCatalog {
  scopeId: ScopeId;
  emoji: Record<string, string>;
  updatedAt: number;
}

export interface ConfigTables {
  readonly fresh?: boolean;
  scopeSettings(ids?: readonly ScopeId[]): Promise<Array<[ScopeId, ScopeSettings]>>;
  scopeSetting(id: ScopeId): Promise<ScopeSettings | null>;
  updateScopeSetting(id: ScopeId, fn: (current: ScopeSettings) => ScopeSettings): Promise<ScopeSettings>;
  soulRevisions(perScope: number, ids?: readonly ScopeId[]): Promise<SoulRevision[]>;
  appendSoul(revision: SoulRevision, expectedVersion: number, baseVersion: number): Promise<boolean>;
  claimOrg(orgId: string): Promise<string>;
  purposeRuntimes(): Promise<Partial<Record<RuntimePurpose, RuntimeSelection>>>;
  setPurposeRuntime(purpose: RuntimePurpose, selection: RuntimeSelection | null): Promise<void>;
  connectorClients(id: ScopeId): Promise<StoredConnectorClient[]>;
  connectorClient(id: ScopeId, provider: string): Promise<StoredConnectorClient | null>;
  putConnectorClient(client: StoredConnectorClient): Promise<void>;
  deleteConnectorClient(id: ScopeId, provider: string): Promise<void>;
  slackEmojiCatalog(id: ScopeId): Promise<SlackEmojiCatalog | null>;
  putSlackEmojiCatalog(catalog: SlackEmojiCatalog): Promise<void>;
  close?(): Promise<void>;
}

export function definedOnly<T extends object>(value: T): T {
  const copy = { ...value };
  for (const key in copy) if (copy[key] === undefined) delete copy[key];
  return copy;
}
