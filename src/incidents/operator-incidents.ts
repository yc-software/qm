import type { ErrorEvent, ErrorLog } from "../admin/error-log.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { DirectoryStore } from "../directory/directory-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createNoopLeaderLease, type LeaderLease } from "../persistence/leader-lease.ts";
import type { RunActivityEntry, RunActivityStore } from "../runs/run-activity-store.ts";
import type { Run, RunStore } from "../runs/run-store.ts";
import type { Session, ScopeId } from "../types.ts";
import { personalScope } from "../types.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { hashId } from "../util/crypto.ts";
import { swallowAs } from "../util/errors.ts";
import { headSlice } from "../util/text.ts";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";
import type { OperatorIncident, OperatorIncidentStore, RecordOperatorIncident } from "./incident-store.ts";

const ERROR_SCAN_LIMIT = 200;
const NOTIFICATION_BATCH = 25;
const ERROR_LOOKBACK_MS = 60_000;
const ERROR_ESCALATION_GRACE_MS = 5_000;
const CURSOR_KEY = "operator-incidents:error-cursor:v1";
const LEASE_KEY = "operator-incidents:tick";

export interface OperatorIncidentCursor {
  lastAt: number;
}

export interface ToolFailure {
  tool: string;
  message: string;
}

export interface OperatorIncidentDeps {
  incidents: OperatorIncidentStore;
  errors: ErrorLog;
  runs: RunStore;
  runActivity: RunActivityStore;
  sessions: SessionStore;
  deliveries: DeliveryStore;
  directory: DirectoryStore;
  recipient: string;
  orgScopeId: ScopeId;
  intervalMs?: number;
  backendEscalationGraceMs?: number;
  cursors: DurableMap<OperatorIncidentCursor>;
  maskSecrets?: (text: string) => string;
  leaderLease?: LeaderLease;
  now?: () => number;
}

const FAILURE_MARKER = /^\s*\[(?:tool|publish|write|read|execute|connector)[^\]]*(?:failed|error)[^\]]*\]/i;
const DECLARED_INABILITY =
  /(?:^|[.!?]\s+)(?:i\s+(?:(?:can(?:not|'t|’t)|could\s+not|couldn't|couldn’t)\s+(?:complete|perform|access|open|read|write|publish|connect|send|run|proceed|continue|create|do|use)\b|am\s+unable\s+to\s+(?:complete|perform|access|open|read|write|publish|connect|send|run|proceed|continue|create|do|use)\b)|(?:this|that|the\s+task)\s+(?:is\s+)?blocked\b|unable\s+to\s+(?:complete|perform|access|open|read|write|publish|connect|send|run|proceed|continue|create|do|use)\b)/i;

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function sanitizeIncidentText(
  value: unknown,
  maskSecrets: (text: string) => string = (text) => text,
  maxChars = 480,
): string {
  let text = scalar(value) ?? "";
  text = maskSecrets(text);
  text = text.replace(/\bBearer\s+\S+/gi, "Bearer <redacted>");
  text = text.replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "<redacted>");
  text = text.replace(/\b(?:sk|xox[baprs]|gh[pousr]|pat|AIza|FlyV1)[A-Za-z0-9._-]{8,}\b/g, "<redacted>");
  text = text.replace(
    /(["']?(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    "$1<redacted>",
  );
  text = text.replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, "$1?<redacted>");
  text = text.replace(/\b[A-Za-z]:\\[^\r\n\t"']+/g, "<path>");
  text = text.replace(/(?:^|\s)\/(?:app|root|home|tmp|workspace)\/[^\s"']+/g, " <path>");
  text = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return headSlice(text, maxChars);
}

export function replyDeclaresInability(reply: string | undefined): boolean {
  return Boolean(reply && DECLARED_INABILITY.test(reply));
}

export function explicitToolFailures(
  activity: readonly RunActivityEntry[],
  maskSecrets: (text: string) => string = (text) => text,
): ToolFailure[] {
  const failures: ToolFailure[] = [];
  for (const entry of activity) {
    if (entry.type !== "tool_result") continue;
    const payload = entry.payload;
    if (typeof payload === "string") {
      if (FAILURE_MARKER.test(payload))
        failures.push({ tool: "tool", message: sanitizeIncidentText(payload, maskSecrets) });
      continue;
    }
    if (!payload || typeof payload !== "object") continue;
    const row = payload as Record<string, unknown>;
    const resultText = scalar(row.result ?? row.output ?? row.content);
    const explicit =
      row.isError === true ||
      row.ok === false ||
      row.success === false ||
      row.status === "failed" ||
      row.status === "error" ||
      row.error !== undefined ||
      Boolean(resultText && FAILURE_MARKER.test(resultText));
    if (!explicit) continue;
    const message = sanitizeIncidentText(row.error ?? row.message ?? resultText ?? "Tool call failed", maskSecrets);
    failures.push({ tool: sanitizeIncidentText(row.tool ?? row.name ?? "tool", maskSecrets, 80), message });
  }
  return failures;
}

function runIncident(
  run: Run,
  session: Session | null,
  fallbackScopeId: ScopeId,
  toolFailures: readonly ToolFailure[],
  backendErrors: readonly ErrorEvent[],
  maskSecrets: (text: string) => string,
  now: number,
): RecordOperatorIncident | null {
  const result = run.result;
  const declaredInability = replyDeclaresInability(result?.reply);
  const failed = run.status === "failed" || result?.status === "failed";
  const refused = result?.status === "refused";
  if (!failed && !refused && !declaredInability && toolFailures.length === 0) return null;

  const intentional = refused;
  const discrepancy =
    declaredInability && !failed && !refused && toolFailures.length === 0 && backendErrors.length === 0;
  const recovered = !failed && !refused && !declaredInability;
  let category = "execution";
  let code = "recovered_with_errors";
  if (failed) code = "run_failed";
  else if (refused) {
    category = "policy";
    code = result?.refusalKind ?? "refused";
  } else if (declaredInability) {
    category = "capability";
    code = "declared_inability";
  }
  const backendMessage = sanitizeIncidentText(
    backendErrors[0]?.message ??
      result?.reason ??
      toolFailures[0]?.message ??
      "The agent reported an inability although the backend marked the run successful.",
    maskSecrets,
  );
  const startedAt = run.startedAt ?? run.createdAt;
  const finishedAt = run.finishedAt ?? now;
  const request = run.request.displayText?.trim() || run.request.text.trim();
  return {
    idempotencyKey: `run:${run.id}`,
    source: "run",
    severity: failed ? "error" : "warning",
    status: recovered ? "recovered" : "open",
    category,
    code,
    intentional,
    discrepancy,
    occurredAt: finishedAt,
    scopeLabel: session?.scopeId ?? fallbackScopeId,
    sessionId: session?.id ?? run.sessionId,
    runId: run.id,
    actorLabel: sanitizeIncidentText(run.request.actor.displayName ?? run.request.actor.id, maskSecrets, 120),
    ...(run.request.surface ? { surface: sanitizeIncidentText(run.request.surface, maskSecrets, 60) } : {}),
    ...(request ? { requestSummary: sanitizeIncidentText(request, maskSecrets, 260) } : {}),
    backendMessage,
    ...(result?.reply ? { replySummary: sanitizeIncidentText(result.reply, maskSecrets, 260) } : {}),
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt),
    attempts: run.attempts,
    toolFailureCount: toolFailures.length,
    backendErrorCount: backendErrors.length,
    notificationRequested: true,
  };
}

function backendIncident(
  event: ErrorEvent,
  maskSecrets: (text: string) => string,
  notificationRequested = !event.sessionId,
): RecordOperatorIncident {
  const intentional = event.category === "command_policy" || event.category === "security";
  const fingerprint = hashId([
    String(event.ts),
    event.category,
    event.code,
    event.scopeLabel,
    event.sessionId ?? "",
    event.message,
  ]);
  return {
    idempotencyKey: `backend:${fingerprint}`,
    source: "backend",
    severity: event.category === "database" || event.category === "worker" ? "critical" : "error",
    status: "open",
    category: sanitizeIncidentText(event.category, maskSecrets, 80),
    code: sanitizeIncidentText(event.code, maskSecrets, 80),
    intentional,
    discrepancy: false,
    occurredAt: event.ts,
    scopeLabel: event.scopeLabel,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    backendMessage: sanitizeIncidentText(event.message, maskSecrets),
    notificationRequested,
  };
}

function slackText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/`/g, "'");
}

function durationLabel(durationMs: number | undefined): string {
  if (durationMs === undefined) return "not available";
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

export function formatOperatorIncident(incident: OperatorIncident): string {
  const unix = Math.floor(incident.occurredAt / 1000);
  let outcome = "Needs attention";
  if (incident.intentional) outcome = "Intentionally stopped by a safety or access rule";
  else if (incident.status === "recovered") outcome = "Recovered, but a real backend error occurred";
  else if (incident.discrepancy) outcome = "Agent reported an inability without a matching backend failure";
  const icon = incident.severity === "critical" ? ":rotating_light:" : ":warning:";
  const lines = [
    `${icon} *AitlasQM incident* · \`${incident.id.slice(0, 8).toUpperCase()}\``,
    `*When:* <!date^${unix}^{date_short_pretty} at {time_secs}|${new Date(incident.occurredAt).toISOString()}>`,
    `*Asked by:* ${slackText(incident.actorLabel ?? "System process")}`,
    ...(incident.requestSummary ? [`*Request:* ${slackText(incident.requestSummary)}`] : []),
    `*Outcome:* ${outcome}`,
    ...(incident.replySummary ? [`*Agent said:* ${slackText(incident.replySummary)}`] : []),
    `*Backend truth:* ${slackText(incident.backendMessage)}`,
  ];
  if (incident.durationMs !== undefined || incident.attempts !== undefined) {
    const attempts = incident.attempts ?? 0;
    lines.push(`*Execution:* ${durationLabel(incident.durationMs)} · ${attempts} attempt${attempts === 1 ? "" : "s"}`);
  }
  if (incident.toolFailureCount || incident.backendErrorCount) {
    lines.push(
      `*Evidence:* ${incident.toolFailureCount ?? 0} tool failure${incident.toolFailureCount === 1 ? "" : "s"} · ${incident.backendErrorCount ?? 0} backend error${incident.backendErrorCount === 1 ? "" : "s"}`,
    );
  }
  return lines.join("\n");
}

export function createOperatorIncidentRuntime(deps: OperatorIncidentDeps): Sweeper {
  const now = deps.now ?? Date.now;
  const maskSecrets = deps.maskSecrets ?? ((text: string) => text);
  const lease = deps.leaderLease ?? createNoopLeaderLease();

  deps.runs.onTerminal((run) => {
    void (async () => {
      const session = await deps.sessions.getByThread(run.sessionId);
      const [activity, backendErrors] = await Promise.all([
        deps.runActivity.list(run.id),
        session
          ? deps.errors.list({ sessionId: session.id, since: run.startedAt ?? run.createdAt, limit: ERROR_SCAN_LIMIT })
          : Promise.resolve([]),
      ]);
      const finishedAt = run.finishedAt ?? now();
      const boundedErrors = backendErrors.filter((e) => e.ts <= finishedAt + 5_000);
      for (const event of boundedErrors) {
        const covered = await deps.incidents.record(backendIncident(event, maskSecrets, false));
        await deps.incidents.markStatus(covered.id, "acknowledged", now());
      }
      const incident = runIncident(
        run,
        session,
        deps.orgScopeId,
        explicitToolFailures(activity, maskSecrets),
        boundedErrors,
        maskSecrets,
        now(),
      );
      if (incident) await deps.incidents.record(incident);
    })().catch(swallowAs(`operator incidents: terminal run ${run.id}`, undefined));
  });

  async function ingestBackendErrors(): Promise<void> {
    const existing = await deps.cursors.get(CURSOR_KEY);
    if (!existing) {
      await deps.cursors.put(CURSOR_KEY, { lastAt: now() });
      return;
    }
    const observedAt = now();
    const events = await deps.errors.list({
      since: Math.max(0, existing.lastAt - ERROR_LOOKBACK_MS),
      limit: ERROR_SCAN_LIMIT,
    });
    for (const event of events) await deps.incidents.record(backendIncident(event, maskSecrets));
    await deps.cursors.put(CURSOR_KEY, { lastAt: observedAt });
  }

  async function escalateUncoveredBackendErrors(): Promise<void> {
    const cutoff = now() - (deps.backendEscalationGraceMs ?? ERROR_ESCALATION_GRACE_MS);
    for (const incident of await deps.incidents.pendingEscalations(cutoff, NOTIFICATION_BATCH)) {
      if (incident.sessionId) {
        const session = await deps.sessions.get(incident.sessionId);
        if (session && (await deps.runs.activeForThread(session.threadRef))) continue;
      }
      await deps.incidents.requestNotification(incident.id, now());
    }
  }

  async function resolveRecipient(): Promise<{ principalId: string; slackId: string } | null> {
    const resolution = await deps.directory.resolve(deps.recipient);
    if (resolution.kind !== "one" || !resolution.member.slackId) {
      console.error(`[operator-incidents] recipient could not be resolved to one Slack member`);
      return null;
    }
    return { principalId: resolution.member.principalId, slackId: resolution.member.slackId };
  }

  async function deliverReceipts(): Promise<void> {
    for (const incident of await deps.incidents.pendingReceipts(NOTIFICATION_BATCH)) {
      const delivery = await deps.deliveries.get(incident.notificationDeliveryId!);
      if (delivery?.deliveredAt) await deps.incidents.markNotificationDelivered(incident.id, delivery.deliveredAt);
    }
  }

  async function notifyPending(): Promise<void> {
    const pending = await deps.incidents.pendingNotifications(NOTIFICATION_BATCH);
    if (!pending.length) return;
    const recipient = await resolveRecipient();
    if (!recipient) return;
    for (const incident of pending) {
      const delivery = await deps.deliveries.enqueue({
        destination: {
          type: "principal",
          target: recipient.slackId,
          audienceScopeId: personalScope(recipient.principalId),
        },
        text: formatOperatorIncident(incident),
        idempotencyKey: `operator-incident:${incident.id}`,
      });
      await deps.incidents.markNotificationQueued(incident.id, delivery.id, now());
    }
  }

  const sweep = () =>
    lease.hold(LEASE_KEY, async () => {
      await ingestBackendErrors();
      await escalateUncoveredBackendErrors();
      await deliverReceipts();
      await notifyPending();
    });
  const sweeper = createSweeper(sweep, deps.intervalMs ?? 30_000, { label: "operator incidents", immediate: true });
  let unsubscribe: (() => void) | undefined;
  return {
    start(intervalMs) {
      if (!unsubscribe) {
        unsubscribe = deps.errors.onRecord((event) => {
          void deps.incidents
            .record(backendIncident(event, maskSecrets))
            .catch(swallowAs(`operator incidents: backend ${event.category}/${event.code}`, undefined));
        });
      }
      sweeper.start(intervalMs);
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      sweeper.stop();
    },
  };
}
