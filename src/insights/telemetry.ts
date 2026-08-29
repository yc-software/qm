import { randomUUID } from "node:crypto";
import type { AuditEvent, AuditLog } from "../audit/audit-log.ts";
import type { ErrorLog } from "../admin/error-log.ts";
import type { MetricsSink } from "../admin/metrics-sink.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { scopeKind } from "../types.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";
import { createSweeper } from "../util/sweeper.ts";

export type TelemetryProps = Record<string, string | number | boolean>;

export interface Telemetry {
  track(event: string, props?: TelemetryProps): void;
  tapAudit(log: AuditLog): AuditLog;
  tapMetrics(sink: MetricsSink): MetricsSink;
  tapErrors(log: ErrorLog): ErrorLog;
  start(): void;
  stop(): Promise<void>;
  flush(): Promise<void>;
}

export interface PersistedTelemetryInstance {
  id: string;
  lastHeartbeatAt?: number;
}

export interface TelemetryDeps {
  apiKey?: string;
  host: string;
  enabled: () => boolean;
  confirmEnabled?: () => Promise<boolean>;
  instances: DurableMap<PersistedTelemetryInstance>;
  version?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export const AUDIT_TELEMETRY_EVENTS: Readonly<Record<string, string>> = {
  skill_create: "skill_installed",
  skill_promote: "skill_promoted",
  skill_archive: "skill_archived",
  "skill_pack.import": "skill_pack_imported",
  cron_create: "cron_created",
  cron_delete: "cron_deleted",
  webhook_create: "webhook_created",
  deploy: "web_app_deployed",
  deploy_version: "web_app_published",
  deploy_rollback: "web_app_rolled_back",
  "connector.oauth.connected": "connector_connected",
  "connector.oauth.revoked": "connector_revoked",
  "connector.token.set": "connector_token_set",
  "keychain.save": "credential_added",
  "keychain.delete": "credential_deleted",
  "file.upload": "file_uploaded",
  file_share: "file_shared",
  "memory.update": "memory_updated",
  "memory.agent.capture": "memory_captured",
  "project.create": "project_created",
  "project.member.add": "project_member_added",
  "session.fork": "session_forked",
  "session.spawn": "session_spawned",
  grant: "grant_created",
  "grant.create": "grant_created",
  "grant.revoke": "grant_revoked",
  environment_create: "environment_created",
  "user.onboarding.set": "onboarding_status_set",
};

export const CONFIG_UPDATE_ACTIONS: ReadonlySet<string> = new Set(
  [
    "security-posture",
    "approval-grant-modes",
    "command-policy",
    "soul",
    "ambient-policy",
    "egress",
    "device-flow-cutover",
    "unfulfilled-insights",
    "external-slack-participants",
    "channel-header-pin-default",
    "org-ambient",
    "interactive-fast-mode",
    "telemetry",
    "base-model",
    "runtime",
    "approved-harnesses",
    "webui-models",
    "people-directory-url",
    "ack-emoji",
    "branding",
    "turn-wall-clock",
    "browse-model",
    "browse-max-steps",
    "connectors",
    "service-credentials",
    "runtime-config",
    "mcp-servers",
    "model-providers",
    "custom-providers",
    "slack-installation",
  ].map((resource) => `${resource}.update`),
);

const QUEUE_MAX = 1000;
const FLUSH_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60_000;
const SEND_TIMEOUT_MS = 10_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;
const SHUTDOWN_FLUSH_MS = 2_000;

export function createTelemetry(deps: TelemetryDeps): Telemetry {
  const apiKey = deps.apiKey;
  if (!apiKey) {
    return {
      track() {},
      tapAudit: (log) => log,
      tapMetrics: (sink) => sink,
      tapErrors: (log) => log,
      start() {},
      async stop() {},
      async flush() {},
    };
  }
  const now = deps.now ?? Date.now;
  const send = deps.fetchImpl ?? fetch;
  const flushQueue = createKeyedQueue();
  const queue: { event: string; properties: TelemetryProps; timestamp: string }[] = [];
  let instanceId: string | null = null;
  let confirmedOn: boolean | null = null;
  let failures = 0;
  let retryAt = 0;
  const isOn = (): boolean => confirmedOn ?? deps.enabled();
  const trim = (): void => {
    if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX);
  };
  const track = (event: string, props: TelemetryProps = {}): void => {
    if (!isOn()) return;
    queue.push({
      event,
      properties: { ...props, ...(deps.version ? { version: deps.version } : {}) },
      timestamp: new Date(now()).toISOString(),
    });
    trim();
  };
  const instanceRow = (): Promise<PersistedTelemetryInstance> =>
    deps.instances.putIfAbsent("singleton", { id: randomUUID() });
  const maybeHeartbeat = async (): Promise<void> => {
    const row = await instanceRow();
    if (now() - (row.lastHeartbeatAt ?? 0) < HEARTBEAT_INTERVAL_MS) return;
    track("instance_heartbeat");
    await deps.instances.put("singleton", { ...row, lastHeartbeatAt: now() });
  };
  const flush = (): Promise<void> =>
    flushQueue("flush", async () => {
      confirmedOn = deps.confirmEnabled ? await deps.confirmEnabled() : deps.enabled();
      if (!confirmedOn) {
        queue.length = 0;
        return;
      }
      if (now() < retryAt) return;
      await maybeHeartbeat();
      if (queue.length === 0) return;
      instanceId ??= (await instanceRow()).id;
      const events = queue.splice(0, queue.length);
      try {
        const res = await send(`${deps.host}/batch/`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            batch: events.map((e) => ({
              ...e,
              distinct_id: instanceId,
              properties: {
                ...e.properties,
                $lib: "qm",
                $geoip_disable: true,
                $process_person_profile: false,
              },
            })),
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (res.ok) {
          failures = 0;
          retryAt = 0;
          return;
        }
        const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
        if (!permanent) {
          queue.unshift(...events);
          trim();
        }
        throw new Error(`posthog batch rejected: ${res.status}`);
      } catch (e) {
        if (e instanceof TypeError || (e instanceof DOMException && e.name === "TimeoutError")) {
          queue.unshift(...events);
          trim();
        }
        failures += 1;
        retryAt = now() + Math.min(FLUSH_INTERVAL_MS * 2 ** failures, MAX_RETRY_DELAY_MS);
        throw e;
      }
    });
  const auditProps = (e: AuditEvent): TelemetryProps => ({
    audit_action: e.action,
    scope_kind: scopeKind(e.scopeLabel),
    ...(e.status ? { status: e.status } : {}),
  });
  const trackAudit = (e: AuditEvent): void => {
    if (Object.hasOwn(AUDIT_TELEMETRY_EVENTS, e.action)) {
      track(AUDIT_TELEMETRY_EVENTS[e.action]!, auditProps(e));
      return;
    }
    if (CONFIG_UPDATE_ACTIONS.has(e.action)) {
      track("config_updated", { ...auditProps(e), section: e.action.slice(0, -".update".length) });
    }
  };
  const sweeper = createSweeper(() => flush(), FLUSH_INTERVAL_MS, { label: "telemetry" });
  return {
    track,
    tapAudit: (log) => ({
      ...log,
      record(e) {
        log.record(e);
        trackAudit(e);
      },
    }),
    tapMetrics: (sink) => ({
      ...sink,
      record(s) {
        sink.record(s);
        track(s.status === "capture" ? "memory_auto_captured" : "turn_completed", {
          status: s.status,
          scope_kind: scopeKind(s.scopeLabel),
          duration_ms: s.totalMs,
          ...(s.toolCalls !== undefined ? { tool_calls: s.toolCalls } : {}),
          ...(s.modelCalls !== undefined ? { model_calls: s.modelCalls } : {}),
        });
      },
    }),
    tapErrors: (log) => ({
      ...log,
      record(e) {
        log.record(e);
        track("error_recorded", { category: e.category, code: e.code, scope_kind: scopeKind(e.scopeLabel) });
      },
    }),
    start: () => sweeper.start(),
    async stop() {
      sweeper.stop();
      await Promise.race([
        flush().catch(swallowAs("telemetry: final flush failed", undefined)),
        sleep(SHUTDOWN_FLUSH_MS, { unref: true }),
      ]);
    },
    flush,
  };
}
