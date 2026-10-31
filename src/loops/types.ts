import type { TurnResult } from "../types.ts";
import type { TriggerBase } from "../triggers/types.ts";

export type LoopState = "enabled" | "paused" | "quarantined" | "archived";

export type LoopHealth = "healthy" | "degraded" | "failing" | "quarantined";

export type ShipGate = "hold" | "auto";

export interface ShipActionPolicy {
  action: string;
  gate: ShipGate;
}

export interface LoopCaps {
  maxItemsPerFire?: number;
  maxConcurrentItems?: number;
  maxOpenOutputs?: number;
  maxItemAttempts?: number;
}

export interface LoopGovernorConfig {
  maxConsecutiveFailedFires?: number;
  maxQueueDepth?: number;
  maxQueueAgeMs?: number;
  maxReturnRate?: number;
  returnRateMinDecisions?: number;
  staleFireMs?: number;
}

interface LoopTriageSetting {
  enabled: boolean;
  instructions?: string;
}

export interface LoopTriageConfig {
  prioritize?: LoopTriageSetting;
  consolidate?: LoopTriageSetting;
}

interface LoopPlaybookRevision {
  version: number;
  at: number;
  by: string;
  note?: string;
}

export interface Loop extends TriggerBase {
  name: string;
  icon?: string;
  purpose?: string;
  surface?: string;
  sources?: string[];
  playbook: string;
  playbookVersion: number;
  playbookHistory: LoopPlaybookRevision[];
  policyVersion: number;
  successCondition: string;
  successChecks?: string[];
  shipActions: ShipActionPolicy[];
  caps?: LoopCaps;
  governor?: LoopGovernorConfig;
  triage?: LoopTriageConfig;
  state: LoopState;
  health: LoopHealth;
  healthReason?: string;
  throttle?: boolean;
  cronId?: string;
  consecutiveFailedFires?: number;
  quarantineClearedBy?: string;
  quarantineClearedAt?: number;
}

export type LoopItemStatus = "queued" | "in_progress" | "ready" | "shipped" | "failed" | "skipped";

export type LoopSourcePayload = Record<string, unknown>;

export interface LoopProposal {
  data: LoopSourcePayload;
  summary?: string;
  by: "agent" | "human";
  at: number;
  sessionId?: string;
}

export interface LoopThreadMessage {
  id: string;
  role: "human" | "agent" | "system";
  text: string;
  at: number;
  actorId?: string;
}

export type LoopItemPriority = "urgent" | "high" | "normal" | "low";

export interface LoopItemTriage {
  at: number;
  priority?: LoopItemPriority;
  reason?: string;
  groupId?: string;
  pinned?: Array<"priority" | "group">;
}

export interface LoopItem {
  previousLoopId?: string;
  triage?: LoopItemTriage;
  inboxPreview?: LoopSourcePayload;
  id: string;
  loopId: string;
  sourceKey: string;
  sourceSummary?: string;
  source?: string;
  sourcePayload?: LoopSourcePayload;
  sourceAt?: number;
  proposal?: LoopProposal;
  agentDrafts?: LoopProposal[];
  agentMentionKeys?: string[];
  thread?: LoopThreadMessage[];
  status: LoopItemStatus;
  attempts: number;
  runIds: string[];
  outputIds: string[];
  parkedReason?: string;
  guidance?: string;
  actedAt?: number;
  actionKind?: string;
  actionResult?: string;
  claimedAt?: number;
  claimToken?: string;
  decisionAt?: number;
  decisionToken?: string;
  createdAt: number;
  updatedAt: number;
}

export type LoopOutputState =
  "staged" | "ready" | "shipping" | "unconfirmed" | "shipped" | "returned" | "superseded" | "expired";

export interface LoopShipResult {
  status?: TurnResult["status"];
  note?: string;
  reply?: string;
  sessionId?: string;
}

export interface LoopOutput {
  id: string;
  loopId: string;
  itemId: string;
  attemptId: string;
  shipAction: string;
  label?: string;
  externalRef?: string;
  title: string;
  summary?: string;
  state: LoopOutputState;
  capturedBy: "ledger" | "classifier" | "agent";
  createdAt: number;
  updatedAt: number;
  decidedBy?: string;
  decidedAt?: number;
  decisionNote?: string;
  claimedAt?: number;
  claimToken?: string;
  shipFireKey?: string;
  shipResult?: LoopShipResult;
  supersedesOutputIds?: string[];
  supersededByOutputIds?: string[];
}

export interface ShipGrant {
  id: string;
  loopId: string;
  shipAction: string;
  label?: string;
  actorId: string;
  policyVersion: number;
  createdAt: number;
  revokedAt?: number;
  revokedBy?: string;
  revocationHistory?: Array<{ revokedAt: number; revokedBy: string }>;
}
