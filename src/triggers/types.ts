import type { RuntimeChoice } from "../agent/agent.ts";
import type { Destination, ScopeId, TurnResult } from "../types.ts";

export interface TriggerBase {
  id: string;
  ownerScopeId: ScopeId;
  owner: string;
  createdBy: string;
  ownerConsentedAt?: number;
  botActor?: boolean;
  taskAuthor?: "automation";
  destination?: Destination;
  enabled: boolean;
  createdAt: number;
  lastFiredAt?: number;
}

export interface CronSchedule {
  cron?: string;
  timezone?: string;
  everyMs?: number;
  firstFireAt?: number;
}

export interface CronFireLogEntry {
  fireKey: string;
  threadRef: string;
  firedAt: number;
  scheduledAt?: number;
  status?: TurnResult["status"] | "running";
  endedAt?: number;
  note?: string;
  reply?: string;
  sessionId?: string;
}

export interface CronScript {
  command: string;
  credentials?: string[];
  sandboxId?: string;
}

export interface CronFireNote {
  text: string;
  at: number;
  by?: string;
}

export interface Cron extends TriggerBase {
  runtime?: RuntimeChoice | null;
  schedule: CronSchedule;
  nextFireAt?: number;
  lastAttemptAt?: number;
  deferUntil?: number;
  title?: string;
  archived?: boolean;
  action?: string;
  message?: string;
  loopId?: string;
  createdAt: number;
  sessionRef?: string;
  script?: CronScript;

  lastFireNote?: CronFireNote;
}

interface WebhookVerification {
  scheme: "hmac-sha256" | "github" | "slack" | "stripe" | "linear";
  secret?: string;
}

interface WebhookFilter {
  path: string;
  in: string[];
}

export interface Webhook extends TriggerBase {
  action: string;
  verification: WebhookVerification;
  filters?: WebhookFilter[];
  lastDeliveryId?: string;
  lastError?: string;
}

export interface Monitor extends TriggerBase {
  processId: string;
  command: string;
  purpose?: string;
  threadRef: string;
  instructions?: string;
  pattern?: string;
  cursor: number;
  tail?: string;
  expiresAt: number;
  lastError?: string;
}
