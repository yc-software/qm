import type { App } from "../../app.ts";
import { parseScopeId, type Cron, type Delivery, type Session } from "../../../types.ts";
import type { SessionSummary } from "../../../sessions/session-store.ts";
import { parseWakeFireKey, wakeTriggerLabel } from "../../../triggers/provenance.ts";

function adminCron(
  c: Cron | null,
): Pick<
  Cron,
  | "id"
  | "ownerScopeId"
  | "title"
  | "action"
  | "message"
  | "owner"
  | "createdBy"
  | "enabled"
  | "archived"
  | "schedule"
  | "createdAt"
  | "lastFiredAt"
> | null {
  if (!c) return null;
  return {
    id: c.id,
    ownerScopeId: c.ownerScopeId,
    title: c.title,
    action: c.action,
    message: c.message,
    owner: c.owner,
    createdBy: c.createdBy,
    enabled: c.enabled,
    archived: c.archived,
    schedule: c.schedule,
    createdAt: c.createdAt,
    lastFiredAt: c.lastFiredAt,
  };
}

type AdminCronOrigin = {
  kind: "cron";
  label: string;
  cronId: string;
  fireKey: string;
  fireSlot: string | null;
  monologue?: boolean;
  cron: ReturnType<typeof adminCron>;
};

type AdminWakeOrigin = {
  kind: "background_wake";
  label: string;
  trigger: string;
  fireKey: string;
  fireSlot: string | null;
  sourceId: string | null;
  sourceScopeId?: string;
  sourceThreadRef?: string;
  monologue?: boolean;
};

export type AdminOrigin = AdminCronOrigin | AdminWakeOrigin;

export type AdminSessionCategory = "conversation" | "background";
export type AdminSessionOrigin = "cron" | "other_background";

export type AdminWakeRef = NonNullable<ReturnType<typeof parseWakeFireKey>> & {
  monologue?: boolean;
};

export function parseSessionWakeRef(threadRef: string | undefined | null): AdminWakeRef | null {
  const fire = parseWakeFireKey(threadRef);
  if (fire) return fire;
  const stable = /^agent:main:([a-z][a-z0-9_-]*):([^:]+)$/.exec(threadRef ?? "");
  if (!stable) return null;
  const trigger = stable[1];
  const sourceId = stable[2];
  if (!trigger || !sourceId) return null;
  const parsed = parseWakeFireKey(`${trigger}:${sourceId}`);
  return parsed ? { ...parsed, fireKey: threadRef!, monologue: true } : null;
}

export function sessionCategory(session: Pick<Session, "threadRef"> | SessionSummary): AdminSessionCategory {
  return parseSessionWakeRef(session.threadRef) ? "background" : "conversation";
}

export function sessionKind(session: Pick<Session, "type" | "threadRef"> | SessionSummary): string {
  const wake = parseSessionWakeRef(session.threadRef);
  if (!wake) return session.type;
  return wake.monologue ? `${wake.trigger}_monologue` : `${wake.trigger}_wake`;
}

function wakeSessionLabel(trigger: string, monologue?: boolean): string {
  if (!monologue) return wakeTriggerLabel(trigger);
  switch (trigger) {
    case "cron":
      return "Cron monologue";
    case "monitor":
      return "Monitor monologue";
    case "webhook":
      return "Webhook monologue";
    default:
      return "Background monologue";
  }
}

export async function cronWakeOrigin(
  app: App,
  parsed: AdminWakeRef,
  requestedScope: string,
  sourceScope: string,
  cronLookup?: Map<string, Cron>,
): Promise<AdminCronOrigin> {
  const cron = cronLookup ? (cronLookup.get(parsed.sourceId) ?? null) : await app.getCron(parsed.sourceId);
  const orgWide = parseScopeId(requestedScope).kind === "org";
  return {
    kind: "cron",
    label: wakeSessionLabel("cron", parsed.monologue),
    cronId: parsed.sourceId,
    fireKey: parsed.fireKey,
    fireSlot: parsed.fireSlot,
    ...(parsed.monologue ? { monologue: true } : {}),
    cron: orgWide || cron?.ownerScopeId === sourceScope ? adminCron(cron) : null,
  };
}

export async function sessionOrigin(
  app: App,
  session: Pick<Session, "threadRef" | "scopeId">,
  requestedScope: string,
  cronLookup?: Map<string, Cron>,
): Promise<AdminOrigin | null> {
  const parsed = parseSessionWakeRef(session.threadRef);
  if (!parsed) return null;
  if (parsed.trigger === "cron") return cronWakeOrigin(app, parsed, requestedScope, session.scopeId, cronLookup);
  return {
    kind: "background_wake",
    label: wakeSessionLabel(parsed.trigger, parsed.monologue),
    trigger: parsed.trigger,
    fireKey: parsed.fireKey,
    fireSlot: parsed.fireSlot,
    sourceId: parsed.sourceId,
    ...(parsed.monologue ? { monologue: true } : {}),
  };
}

export async function deliveryOrigin(
  app: App,
  delivery: Delivery,
  requestedScope: string,
): Promise<AdminOrigin | null> {
  const provenance = delivery.provenance;
  const parsed = parseWakeFireKey(provenance?.fireKey ?? delivery.idempotencyKey);
  const trigger = parsed?.trigger ?? provenance?.trigger;
  if (!trigger || trigger === "conversation") return null;
  if (trigger === "cron" && parsed?.trigger === "cron")
    return cronWakeOrigin(app, parsed, requestedScope, requestedScope);
  return {
    kind: "background_wake",
    label: wakeTriggerLabel(trigger),
    trigger,
    fireKey: provenance?.fireKey ?? parsed?.fireKey ?? delivery.idempotencyKey,
    fireSlot: parsed?.fireSlot ?? null,
    sourceId: parsed?.sourceId ?? null,
    ...(provenance?.sourceScopeId ? { sourceScopeId: provenance.sourceScopeId } : {}),
    ...(provenance?.sourceThreadRef ? { sourceThreadRef: provenance.sourceThreadRef } : {}),
  };
}
