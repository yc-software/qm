import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import { signedRequestHeaders } from "../../plugins/chassis/src/source-auth-sign.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../src/auth/portal-identity.ts";
import type { Cron } from "../../src/types.ts";
import {
  arrivalOffsetMs,
  runWorkload,
  validateWorkload,
  type WorkloadFixture,
  type WorkloadProfile,
} from "./workload.ts";
import { syntheticText, validateProvider, workloadCheck, type ProviderProfile } from "./workload-provider.ts";

export interface HistorySession {
  sessionId: string;
  threadRef: string;
  expectedVisibleText: string;
}

interface HistoryCohort {
  name: string;
  entries: Bound;
  tapeBytes: Bound;
  sessions: HistorySession[];
}

export interface ProducerLane {
  name: string;
  shape: string;
  ratePerSecond: number;
  arrivals?: { warmup: number[]; measured: number[] };
  principalId: string;
  origin: "direct" | "cron";
  subscribers: number;
  history?: HistoryCohort;
  cron?: { scheduleLeadMs: number; maxFireDelayMs: number };
}

interface Bound {
  min: number;
  max: number;
}

export interface ProducerProfile {
  workload: WorkloadProfile;
  databaseUrlEnv: string;
  sourceSecretEnv: string;
  portalIdentitySecretEnv?: string;
  providerUrl: string;
  warmupMs: number;
  guardCase: { sessionId: string; principalId: string; expectedVisibleText: string };
  lanes: ProducerLane[];
  egressEventsPerSecond?: number;
  evidence: { kind: "controlled-envelope"; sourceSha256: string[]; limitations: string[] };
  bounds: {
    running: Bound;
    writes: Record<string, { inserts: Bound; updates: Bound; deletes: Bound }>;
    runEventsPerSecond: Bound;
    runBytesPerSecond: Bound;
  };
}

export const PRODUCER_TABLES = [
  "egress_events",
  "run_activity",
  "runs",
  "session_entries",
  "session_llm_requests",
  "llm_prompt_envelopes",
  "sessions",
  "audit_log",
  "session_tape",
  "job_common",
  "session_spend_days",
  "session_spend_dirty",
  "crons",
  "cron_fires",
];
const TABLES = PRODUCER_TABLES;
export const PRODUCER_QUALIFICATION_GAPS = [
  "slack-ingress-and-delivery",
  "auxiliary-model-traffic",
  "external-tools-and-sandbox-resources",
  "provider-inference-capacity",
  "historical-arrival-correlation",
  "retained-recurring-schedules",
] as const;
type Counter = { relname: string; n_tup_ins: string; n_tup_upd: string; n_tup_del: string; stats_reset: string | null };
type Emit = (record: Record<string, unknown>) => void;

interface ReadFile {
  principalId: string;
  scopeId: string;
  artifactId: string;
  path: string;
  contentBytes: number;
  contentSha256: string;
}

export function reserveHistorySession(lane: ProducerLane, ordinal: number, busy: Set<string>): HistorySession | null {
  if (!lane.history) return null;
  const session = lane.history.sessions[ordinal % lane.history.sessions.length]!;
  workloadCheck(!busy.has(session.threadRef), `Selected history session is busy: ${session.sessionId}`);
  busy.add(session.threadRef);
  return session;
}

export function scheduledCronTime(
  lane: ProducerLane,
  phaseStart: number,
  sequence: number,
  now: number,
  phase = "measured",
): number {
  workloadCheck(lane.origin === "cron" && lane.cron && phaseStart > 0, "Cron schedule is not initialized");
  const firstFireAt = Math.ceil(
    phaseStart +
      arrivalOffsetMs(
        {
          ratePerSecond: lane.ratePerSecond,
          arrivalOffsetsMs: lane.arrivals?.[phase === "warmup" ? "warmup" : "measured"],
        },
        sequence,
      ) +
      lane.cron.scheduleLeadMs,
  );
  workloadCheck(
    Number.isFinite(firstFireAt) && firstFireAt > now,
    "Missed native cron creation slot; refusing to shift its schedule",
  );
  return firstFireAt;
}

export async function verifyReadBytes(response: Response, expected: Pick<ReadFile, "contentBytes" | "contentSha256">) {
  workloadCheck(response.status === 200 && response.body, "Actual durable file bytes are unavailable");
  const hash = createHash("sha256");
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      workloadCheck(bytes <= expected.contentBytes, "Durable file exceeds its declared byte count");
      hash.update(part.value);
    }
    const sha256 = hash.digest("hex");
    workloadCheck(
      bytes === expected.contentBytes && sha256 === expected.contentSha256,
      "Durable file byte/hash mismatch",
    );
    return { bytes, sha256 };
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function origin(value: string): URL {
  const url = new URL(value);
  workloadCheck(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
    "Expected a credential-free HTTP origin",
  );
  return url;
}

function inBound(value: number, bound: Bound | undefined): boolean {
  return Boolean(bound && Number.isFinite(value) && value >= bound.min && value <= bound.max);
}

export function writeRates(before: Counter[], after: Counter[], seconds: number) {
  workloadCheck(seconds > 0, "Counter interval must be positive");
  return TABLES.map((table) => {
    const start = before.find((item) => item.relname === table);
    const end = after.find((item) => item.relname === table);
    workloadCheck(start && end && start.stats_reset === end.stats_reset, `Missing/reset counters: ${table}`);
    const values = ["n_tup_ins", "n_tup_upd", "n_tup_del"].map(
      (key) => Number(end[key as keyof Counter]) - Number(start[key as keyof Counter]),
    );
    workloadCheck(
      values.every((value) => Number.isSafeInteger(value) && value >= 0),
      `Counter decreased: ${table}`,
    );
    return { table, inserts: values[0]! / seconds, updates: values[1]! / seconds, deletes: values[2]! / seconds };
  });
}

export function validateProducer(
  profile: ProducerProfile,
  fixture: WorkloadFixture,
  provider: ProviderProfile,
  env = process.env,
): void {
  validateProvider(provider, fixture, env);
  workloadCheck(profile.workload.requests.length === 0, "Producer requests are generated from guarded lanes");
  const base = origin(profile.workload.baseUrl);
  workloadCheck(
    env.QM_PERFORMANCE_PRODUCER_ORIGIN === base.origin,
    "Set QM_PERFORMANCE_PRODUCER_ORIGIN to the isolated core origin exactly",
  );
  const twin = origin(profile.providerUrl);
  workloadCheck(
    ["127.0.0.1", "localhost", "[::1]"].includes(twin.hostname) || env.QM_PERFORMANCE_PROVIDER_ORIGIN === twin.origin,
    "Remote provider requires exact QM_PERFORMANCE_PROVIDER_ORIGIN",
  );
  workloadCheck(
    typeof env[profile.sourceSecretEnv] === "string" && env[profile.sourceSecretEnv]!.length > 0,
    "Fixture source signing secret required",
  );
  const database = new URL(env[profile.databaseUrlEnv] ?? "");
  workloadCheck(
    ["postgres:", "postgresql:"].includes(database.protocol) &&
      decodeURIComponent(database.pathname.slice(1)) === fixture.databaseName,
    "Database URL must name the fixture database",
  );
  workloadCheck(Number.isSafeInteger(profile.warmupMs) && profile.warmupMs >= 0, "Invalid warmup");
  workloadCheck(
    profile.evidence.kind === "controlled-envelope" && profile.evidence.sourceSha256.length > 0,
    "Measured source hashes required; this producer is a controlled envelope",
  );
  const principals = fixture.principals as Array<{ principalId?: string }> | undefined;
  const names = new Set<string>();
  for (const lane of profile.lanes) {
    workloadCheck(/^[a-zA-Z0-9_-]+$/.test(lane.name) && !names.has(lane.name), "Unique safe lane names required");
    names.add(lane.name);
    workloadCheck(
      principals?.some((item) => item.principalId === lane.principalId) &&
        lane.principalId.endsWith("@example.invalid"),
      "Producer actor must be a seeded synthetic principal",
    );
    const shape = provider.shapes.find((item) => item.name === lane.shape);
    workloadCheck(
      shape &&
        Number.isFinite(lane.ratePerSecond) &&
        (lane.arrivals
          ? lane.ratePerSecond === 0 && Array.isArray(lane.arrivals.warmup) && Array.isArray(lane.arrivals.measured)
          : lane.ratePerSecond > 0),
      "Valid shape and positive rate or explicit phase arrivals required",
    );
    if (lane.arrivals)
      workloadCheck(
        profile.warmupMs > 0 || lane.arrivals.warmup.length === 0,
        "Warmup arrivals require a warmup window",
      );
    workloadCheck(["direct", "cron"].includes(lane.origin), "Use direct turns or the native cron lane");
    workloadCheck(
      lane.origin === "cron"
        ? !lane.history &&
            lane.cron &&
            Number.isSafeInteger(lane.cron.scheduleLeadMs) &&
            lane.cron.scheduleLeadMs >= 1000 &&
            lane.cron.scheduleLeadMs < profile.workload.requestTimeoutMs &&
            Number.isSafeInteger(lane.cron.maxFireDelayMs) &&
            lane.cron.maxFireDelayMs >= 0
        : lane.cron === undefined,
      "Native cron lanes require a future schedule lead and maximum fire delay, without history overrides",
    );
    if (lane.history) {
      workloadCheck(lane.history.name.length > 0 && lane.history.sessions.length > 0, "History cohort is empty");
      const sessionIds = new Set<string>();
      const threadRefs = new Set<string>();
      for (const session of lane.history.sessions) {
        workloadCheck(
          session.sessionId.length > 0 &&
            !sessionIds.has(session.sessionId) &&
            session.threadRef.startsWith(`web:${lane.principalId}:`) &&
            !threadRefs.has(session.threadRef) &&
            session.expectedVisibleText.length > 0,
          "History sessions require unique owned threads and API sentinels",
        );
        sessionIds.add(session.sessionId);
        threadRefs.add(session.threadRef);
      }
      for (const bound of [lane.history.entries, lane.history.tapeBytes])
        workloadCheck(
          Number.isSafeInteger(bound.min) && Number.isSafeInteger(bound.max) && bound.min > 0 && bound.max >= bound.min,
          "Nonempty measured history bounds required",
        );
    }
    workloadCheck(
      Number.isSafeInteger(lane.subscribers) && lane.subscribers >= 1 && lane.subscribers <= 1000,
      "At least one and at most 1000 run subscribers required",
    );
    if (shape.modelCalls > 1) {
      const files = (fixture.workload as { readFiles?: ReadFile[] } | undefined)?.readFiles;
      workloadCheck(
        files?.some(
          (file) =>
            file.principalId === lane.principalId &&
            file.path === shape.readPath &&
            file.path.startsWith("shared/") &&
            typeof file.scopeId === "string" &&
            /^[0-9a-f]{32}$/.test(file.artifactId) &&
            Number.isSafeInteger(file.contentBytes) &&
            file.contentBytes > 0 &&
            /^[0-9a-f]{64}$/.test(file.contentSha256),
        ),
        "Multi-call shape requires a real, hashed fixture read file",
      );
      workloadCheck(
        profile.portalIdentitySecretEnv && env[profile.portalIdentitySecretEnv],
        "Durable-file verification requires the fixture portal identity signer",
      );
    }
  }
  workloadCheck(names.size > 0, "Producer lanes required");
  workloadCheck(
    profile.egressEventsPerSecond === undefined ||
      (Number.isFinite(profile.egressEventsPerSecond) && profile.egressEventsPerSecond >= 0),
    "Invalid egress arrival rate",
  );
  for (const bound of [
    profile.bounds.running,
    profile.bounds.runEventsPerSecond,
    profile.bounds.runBytesPerSecond,
    ...Object.values(profile.bounds.writes).flatMap(Object.values),
  ])
    workloadCheck(
      Number.isFinite(bound.min) && Number.isFinite(bound.max) && bound.min >= 0 && bound.max >= bound.min,
      "Invalid measured bound",
    );
  if (profile.workload.mode === "qualifying")
    workloadCheck(
      profile.evidence.limitations.length === 0 && TABLES.every((table) => profile.bounds.writes[table]),
      "Unmodeled work or missing table bounds blocks qualification",
    );
  const generated = producerWorkload(profile, provider, "validation");
  validateWorkload(generated, fixture, env, true);
  if (profile.warmupMs > 0) validateWorkload(producerWorkload(profile, provider, "warmup"), fixture, env, true);
}

function producerWorkload(profile: ProducerProfile, provider: ProviderProfile, phase: string): WorkloadProfile {
  const result: WorkloadProfile = {
    ...profile.workload,
    durationMs: phase === "warmup" ? profile.warmupMs : profile.workload.durationMs,
    requests: profile.lanes.map((lane) => {
      const shape = provider.shapes.find((item) => item.name === lane.shape)!;
      const nonce = `${phase}.${lane.name}.{{runId}}.{{sequence}}`;
      const marker = `[qm-perf:${provider.fixtureId}:${shape.name}:${nonce}]`;
      return {
        name: lane.name,
        method: "POST",
        path: "/v1/turns?async=1",
        ratePerSecond: lane.ratePerSecond,
        ...(lane.arrivals ? { arrivalOffsetsMs: lane.arrivals[phase === "warmup" ? "warmup" : "measured"] } : {}),
        expectedStatuses: [200],
        body: {
          surface: "web",
          actor: { externalId: lane.principalId },
          conversation: { kind: "dm", threadRef: `web:${lane.principalId}:qm-perf-${provider.fixtureId}-${nonce}` },
          origin: { kind: "direct" },
          model: provider.model,
          harness: "pi",
          text: `${marker}\n${syntheticText(`${phase}:${lane.name}`, Math.max(1, shape.inputBytes - marker.length - 1), shape.repeatedFraction)}`,
          idempotencyKey: `qm-perf:${provider.fixtureId}:${nonce}`,
        },
      };
    }),
  };
  if (profile.egressEventsPerSecond)
    result.requests.push({
      name: "synthetic-egress-record",
      method: "POST",
      path: "/v1/egress-audit",
      ratePerSecond: profile.egressEventsPerSecond,
      body: {
        records: [
          {
            host: "fixture.example.invalid",
            verdict: "ok",
            scopeLabel: `personal:${profile.lanes[0]!.principalId}`,
            principalId: profile.lanes[0]!.principalId,
            port: 443,
          },
        ],
      },
      expectedStatuses: [200],
    });
  return result;
}

export async function consumeRunStream(
  response: Response,
  runId: string,
  signal: AbortSignal,
  onEvent: (record: Record<string, unknown>, bytes: number) => void,
) {
  workloadCheck(
    response.status === 200 && response.headers.get("content-type")?.startsWith("text/event-stream") && response.body,
    "Run SSE connection failed",
  );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  let identified = false;
  let status: string | null = null;
  let toolErrors = 0;
  let resultStatus: string | null = null;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      buffer = (buffer + decoder.decode(next.value, { stream: true })).replace(/\r\n/g, "\n");
      workloadCheck(buffer.length <= 32_000_000, "Oversized run SSE frame");
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end < 0) break;
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const event = JSON.parse(data) as Record<string, unknown>;
        onEvent(event, Buffer.byteLength(frame) + 2);
        if (event.type === "RUN_STARTED") {
          workloadCheck(event.runId === runId, "Run SSE identity mismatch");
          identified = true;
        }
        if (event.type === "CUSTOM" && event.name === "run") {
          workloadCheck(identified, "Run SSE snapshot preceded its identity");
          const value = event.value as { status?: string; result?: { status?: string } };
          status = value.status ?? null;
          resultStatus = value.result?.status ?? null;
        }
        if (event.type === "TOOL_CALL_RESULT" && event.isError === true) toolErrors++;
        if (event.type === "RUN_FINISHED") {
          workloadCheck(event.runId === runId, "Terminal SSE identity mismatch");
          terminal = true;
        }
      }
    }
    workloadCheck(
      identified &&
        terminal &&
        status === "done" &&
        resultStatus !== null &&
        !["failed", "refused", "pending_approval"].includes(resultStatus) &&
        toolErrors === 0,
      "Run did not finish successfully with successful tools",
    );
    return { status, resultStatus, toolErrors };
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function runProducer(
  profile: ProducerProfile,
  fixture: WorkloadFixture,
  provider: ProviderProfile,
  emit: Emit,
  env = process.env,
) {
  validateProducer(profile, fixture, provider, env);
  const producerProfileSha256 = createHash("sha256")
    .update(JSON.stringify({ producer: profile, provider }))
    .digest("hex");
  const providerProfileSha256 = createHash("sha256").update(JSON.stringify(provider)).digest("hex");
  const producerRunId = randomUUID();
  const event: Emit = (record) =>
    emit({
      schemaVersion: 1,
      producerRunId,
      fixtureId: fixture.fixtureId,
      profileSha256: fixture.profileSha256,
      producerProfileSha256,
      providerProfileSha256,
      at: Date.now(),
      ...record,
      ...(record.workloadProfileSha256 ? { schedulerProfileSha256: record.workloadProfileSha256 } : {}),
      workloadProfileSha256: producerProfileSha256,
      qualified: false,
    });
  const client = new Client({
    connectionString: env[profile.databaseUrlEnv],
    application_name: "qm-performance-observer",
    options: "-c default_transaction_read_only=on -c statement_timeout=5000",
  });
  const token = env[provider.tokenEnv]!;
  const twinSnapshot = async () =>
    await fetch(new URL("/__qm_performance", profile.providerUrl), {
      headers: { "x-api-key": token },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    }).then(async (response) => {
      workloadCheck(response.ok, "Provider twin unavailable");
      return (await response.json()) as {
        fixtureId: string;
        populationSha256: string;
        providerProfileSha256: string;
        totals: { calls: number; errors: number; requestBytes: number; responseBytes: number };
      };
    });
  const sign = (method: string, path: string, body = "") =>
    signedRequestHeaders(env[profile.sourceSecretEnv], method, path, body, { "content-type": "application/json" });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    workloadCheck(url.origin === new URL(profile.workload.baseUrl).origin, "Core origin changed");
    const method = init?.method ?? "GET";
    const response = await fetch(input, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers)),
        ...sign(method, `${url.pathname}${url.search}`, String(init?.body ?? "")),
      },
    });
    if (method === "POST" && url.pathname === "/v1/egress-audit") {
      const text = await response.text();
      const accepted = JSON.parse(text) as { accepted?: number; rejected?: number };
      workloadCheck(
        response.status === 200 && accepted.accepted === 1 && accepted.rejected === 0,
        "Synthetic egress record was not accepted",
      );
      return new Response(text, { status: response.status, headers: response.headers });
    }
    return response;
  };
  const api = async <T>(
    method: string,
    path: string,
    body?: unknown,
    signal = AbortSignal.timeout(5000),
  ): Promise<T> => {
    const response = await fetcher(new URL(path, profile.workload.baseUrl), {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
      redirect: "error",
    });
    workloadCheck(response.ok, `Fixture API failed: ${method} ${path} (${response.status})`);
    return (await response.json()) as T;
  };
  const phaseStarts = new Map<string, number>();
  const busyHistory = new Set<string>();
  const createdCrons = new Map<string, string>();
  let cleanupErrors = 0;
  const completedByLane = new Map<string, number>();
  let historyAttestations = 0;
  let cronTerminals = 0;
  const disableCron = async (cronId: string, principalId: string) => {
    const path = `/v1/crons/${encodeURIComponent(cronId)}`;
    const query = `?principalId=${encodeURIComponent(principalId)}`;
    await api("POST", `${path}/disable${query}`, {});
    const disabled = await api<{ cron: Cron }>("GET", `${path}${query}`);
    workloadCheck(disabled.cron?.enabled === false, "Producer cron remained enabled");
    const deadline = Date.now() + 5000;
    const aborted = new Set<string>();
    for (;;) {
      const active = await client.query<{ id: string }>(
        "SELECT r.id FROM cron_fires f JOIN runs r ON r.session_id=f.thread_ref WHERE f.cron_id=$1 AND r.status IN ('pending','running')",
        [cronId],
      );
      for (const row of active.rows) {
        if (aborted.has(row.id)) continue;
        await api("POST", `/v1/runs/${encodeURIComponent(row.id)}/signal`, { kind: "abort" });
        aborted.add(row.id);
        event({ type: "producer-cron-cleanup-abort", cronId, runId: row.id });
      }
      const jobs = await client.query(
        "SELECT 1 FROM pgboss.job WHERE name='cron-fire' AND data->>'cronId'=$1 AND state='active'",
        [cronId],
      );
      if (active.rows.length === 0 && jobs.rows.length === 0) break;
      workloadCheck(Date.now() < deadline, "Producer cron work did not stop after disable");
      await sleep(100);
    }
    createdCrons.delete(cronId);
    event({ type: "producer-cron-disabled", cronId, enabled: false });
  };
  const attestHistory = async (lane: ProducerLane, session: HistorySession, stage: string) => {
    const rows = await client.query(
      "SELECT s.thread_ref,s.scope_id,(SELECT count(*)::int FROM session_entries e WHERE e.session_id=s.id) AS entries,(SELECT count(*)::int FROM session_entries e WHERE e.session_id=s.id AND e.type='user') AS user_turns,(SELECT coalesce(sum(octet_length(t.payload)),0)::text FROM session_tape t WHERE t.session_id=s.id) AS tape_bytes,EXISTS(SELECT 1 FROM runs r WHERE r.session_id=s.thread_ref AND r.status IN ('pending','running')) AS busy FROM sessions s JOIN participants p ON p.session_id=s.id WHERE s.id=$1 AND p.principal_id=$2 AND p.valid_to IS NULL",
      [session.sessionId, lane.principalId],
    );
    const row = rows.rows[0];
    workloadCheck(
      rows.rowCount === 1 &&
        row.thread_ref === session.threadRef &&
        row.scope_id === `personal:${lane.principalId}` &&
        row.user_turns > 0 &&
        inBound(row.entries, lane.history!.entries) &&
        inBound(Number(row.tape_bytes), lane.history!.tapeBytes) &&
        row.busy === false,
      "History identity, ownership, measured bounds or idle state changed",
    );
    event({
      type: "producer-history-attestation",
      stage,
      name: lane.name,
      cohort: lane.history!.name,
      sessionId: session.sessionId,
      ...row,
    });
    historyAttestations++;
    return row;
  };
  const counterSnapshot = async () => {
    const at = Date.now();
    const rows = (
      await client.query<Counter>(
        "SELECT s.relname,s.n_tup_ins::text,s.n_tup_upd::text,s.n_tup_del::text,d.stats_reset::text FROM pg_stat_user_tables s CROSS JOIN pg_stat_database d WHERE d.datname=current_database() AND s.relname=ANY($1)",
        [TABLES],
      )
    ).rows;
    const snapshot = { at, receivedAt: Date.now(), rows };
    event({ type: "producer-counters", ...snapshot });
    return snapshot;
  };
  let activeStreams = 0;
  let measuredEvents = 0;
  let measuredBytes = 0;
  let measuredEnd = 0;
  let measuredStart = 0;
  let sampling: ReturnType<typeof setInterval> | undefined;
  let observing: Promise<void> | null = null;
  const gauges: Array<{ at: number; running: number; pending: number }> = [];
  let observerErrors = 0;
  const sample = async () => {
    try {
      const result = await client.query<{ running: string; pending: string }>(
        "SELECT count(*) FILTER(WHERE status='running')::text AS running,count(*) FILTER(WHERE status='pending')::text AS pending FROM runs WHERE status IN ('running','pending')",
      );
      const row = {
        at: Date.now(),
        running: Number(result.rows[0]!.running),
        pending: Number(result.rows[0]!.pending),
      };
      gauges.push(row);
      event({ type: "producer-gauge", ...row, activeStreams });
    } catch {
      observerErrors++;
      event({ type: "producer-observer-error" });
    }
  };
  try {
    await client.connect();
    const providerIdentity = await twinSnapshot();
    workloadCheck(
      providerIdentity.fixtureId === fixture.fixtureId &&
        providerIdentity.populationSha256 === fixture.profileSha256 &&
        providerIdentity.providerProfileSha256 === providerProfileSha256,
      "Provider twin identity mismatch",
    );
    const marker = await client.query(
      "SELECT current_database() AS database,fixture_id,profile_sha256,status FROM qm_performance_fixture",
    );
    workloadCheck(
      marker.rows.length === 1 &&
        marker.rows[0].database === fixture.databaseName &&
        marker.rows[0].fixture_id === fixture.fixtureId &&
        marker.rows[0].profile_sha256 === fixture.profileSha256 &&
        marker.rows[0].status === "ready",
      "Live database fixture marker mismatch",
    );
    const guardPath = `/v1/sessions/${encodeURIComponent(profile.guardCase.sessionId)}?viewer=${encodeURIComponent(profile.guardCase.principalId)}&tailTurns=1`;
    const guard = await fetcher(new URL(guardPath, profile.workload.baseUrl), {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    const guardText = await guard.text();
    workloadCheck(
      guard.status === 200 && guardText.includes(profile.guardCase.expectedVisibleText),
      "Core fixture sentinel absent",
    );
    const stored = await client.query("SELECT 1 FROM sessions WHERE id=$1", [profile.guardCase.sessionId]);
    workloadCheck(stored.rowCount === 1, "Fixture sentinel absent in target database");
    const verifiedFiles = new Set<string>();
    for (const lane of profile.lanes) {
      for (const session of lane.history?.sessions ?? []) {
        await attestHistory(lane, session, "preflight");
        const path = `/v1/sessions/${encodeURIComponent(session.sessionId)}?viewer=${encodeURIComponent(lane.principalId)}&tailTurns=1`;
        const response = await fetcher(new URL(path, profile.workload.baseUrl), {
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        });
        workloadCheck(
          response.ok && (await response.text()).includes(session.expectedVisibleText),
          "History API sentinel absent",
        );
        event({
          type: "producer-history-api-attestation",
          name: lane.name,
          sessionId: session.sessionId,
          status: response.status,
        });
      }
      const shape = provider.shapes.find((item) => item.name === lane.shape)!;
      if (shape.modelCalls === 1) continue;
      const file = (fixture.workload as { readFiles: ReadFile[] }).readFiles.find(
        (item) => item.principalId === lane.principalId && item.path === shape.readPath,
      )!;
      const key = `${file.principalId}:${file.artifactId}`;
      if (verifiedFiles.has(key)) continue;
      const artifact = await client.query(
        "SELECT f.id,f.name,f.owner_scope_id,f.size_bytes::text,f.sha256 FROM file_artifacts f WHERE f.id=$1 AND f.enabled AND EXISTS(SELECT 1 FROM acl_grants g WHERE g.owner_scope_id=f.owner_scope_id AND g.path=f.path AND g.grantee_scope_id=$2 AND g.permission IN ('read','write'))",
        [file.artifactId, `personal:${file.principalId}`],
      );
      const metadata = artifact.rows[0];
      workloadCheck(
        artifact.rowCount === 1 &&
          metadata.owner_scope_id === file.scopeId &&
          `shared/${metadata.name}` === file.path &&
          Number(metadata.size_bytes) === file.contentBytes &&
          metadata.sha256 === file.contentSha256,
        "Durable read-file metadata or actual ACL grant mismatch",
      );
      const path = `/v1/files/${encodeURIComponent(file.artifactId)}/content`;
      const identity = await mintPortalIdentity(
        { p: file.principalId, exp: Date.now() + profile.workload.requestTimeoutMs + 5000 },
        env[profile.portalIdentitySecretEnv!]!,
      );
      const response = await fetcher(new URL(path, profile.workload.baseUrl), {
        headers: { [PORTAL_IDENTITY_HEADER]: identity },
        signal: AbortSignal.timeout(profile.workload.requestTimeoutMs),
        redirect: "error",
      });
      const verified = await verifyReadBytes(response, file);
      verifiedFiles.add(key);
      event({
        type: "producer-read-file-attestation",
        principalId: file.principalId,
        artifactId: file.artifactId,
        path: file.path,
        scopeId: file.scopeId,
        ...verified,
      });
    }
    const dispatchTurn: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        text: string;
        conversation: { threadRef: string };
        actor: { externalId: string };
      };
      const matched = /\[qm-perf:[^:]+:([^:]+):([^\]]+)\]/.exec(body.text)!;
      const parts = matched[2]!.split(".");
      const lane = profile.lanes.find((item) => parts[1] === item.name);
      workloadCheck(lane && body.actor.externalId === lane.principalId, "Producer lane mismatch");
      const phase = parts[0]!;
      const sequence = Number(parts.at(-1));
      workloadCheck(Number.isSafeInteger(sequence) && sequence >= 0, "Invalid arrival sequence");
      const shape = provider.shapes.find((item) => item.name === lane.shape)!;
      const marker = matched[0];
      body.text = `${marker}\n${syntheticText(matched[2]!, Math.max(1, shape.inputBytes - marker.length - 1), shape.repeatedFraction)}`;
      const startedAt = Date.now();
      let runId: string | undefined;
      let cronId: string | undefined;
      let firstFireAt: number | undefined;
      let requestBody: string;
      let history: HistorySession | null = null;
      let bytes = 0;
      let events = 0;
      let ownedRun = false;
      const stop = new AbortController();
      const signal = AbortSignal.any([stop.signal, ...(init?.signal ? [init.signal] : [])]);
      let streamTasks: Promise<void>[] = [];
      try {
        const ordinal =
          sequence +
          (phase === "measured"
            ? (lane.arrivals?.warmup.length ?? Math.ceil((profile.warmupMs * lane.ratePerSecond) / 1000))
            : 0);
        history = reserveHistorySession(lane, ordinal, busyHistory);
        if (history) {
          await attestHistory(lane, history, "arrival");
          body.conversation.threadRef = history.threadRef;
        }
        if (lane.origin === "cron") {
          firstFireAt = scheduledCronTime(lane, phaseStarts.get(phase) ?? 0, sequence, Date.now(), phase);
          const definition = {
            ownerScopeId: `personal:${lane.principalId}`,
            owner: lane.principalId,
            createdBy: lane.principalId,
            schedule: { firstFireAt },
            title: `QM performance ${producerRunId} ${matched[2]}`,
            action: body.text,
            enabled: true,
            runAs: "owner",
            runtime: { harnessId: "pi", modelId: provider.model },
          };
          requestBody = JSON.stringify(definition);
          const created = await api<{ cron: Cron }>("POST", "/v1/crons", definition, signal);
          workloadCheck(typeof created.cron?.id === "string", "Native cron was not created");
          cronId = created.cron.id;
          createdCrons.set(cronId, lane.principalId);
          workloadCheck(
            created.cron.schedule.firstFireAt === firstFireAt &&
              created.cron.schedule.everyMs === undefined &&
              created.cron.schedule.cron === undefined &&
              created.cron.destination === undefined &&
              Date.now() < firstFireAt,
            "Native cron schedule changed or creation missed its planned fire time",
          );
          event({
            type: "producer-cron-scheduled",
            name: lane.name,
            phase,
            sequence,
            cronId,
            firstFireAt,
            createdAt: Date.now(),
            scheduleLeadMs: lane.cron!.scheduleLeadMs,
          });
          for (;;) {
            signal.throwIfAborted();
            const observed = await client.query(
              "SELECT f.fire_key,f.thread_ref,f.fired_at,f.scheduled_at,f.status,r.id AS run_id FROM cron_fires f LEFT JOIN runs r ON r.session_id=f.thread_ref WHERE f.cron_id=$1",
              [cronId],
            );
            workloadCheck(observed.rows.length <= 1, "One-shot cron fired more than once");
            const fire = observed.rows[0];
            workloadCheck(
              !fire || ["running", "ok"].includes(fire.status),
              "Native scheduled fire failed before run completion",
            );
            if (fire) {
              workloadCheck(
                fire.fire_key === `cron:${cronId}:${firstFireAt}` &&
                  Number(fire.scheduled_at) === firstFireAt &&
                  Number(fire.fired_at) >= firstFireAt &&
                  Number(fire.fired_at) - firstFireAt <= lane.cron!.maxFireDelayMs,
                "Native cron fire identity or lateness mismatch",
              );
              if (fire.run_id) {
                runId = fire.run_id;
                body.conversation.threadRef = fire.thread_ref;
                event({
                  type: "producer-cron-claimed",
                  name: lane.name,
                  cronId,
                  firstFireAt,
                  firedAt: Number(fire.fired_at),
                  runId,
                });
                break;
              }
            }
            workloadCheck(
              fire || Date.now() <= firstFireAt + lane.cron!.maxFireDelayMs,
              "Native scheduler missed the allowed fire window",
            );
            await sleep(100, undefined, { signal });
          }
        } else {
          requestBody = JSON.stringify(body);
          init = { ...init, body: requestBody };
          const response = await fetcher(input, init);
          const accepted = (await response.json()) as { runId?: string; status?: string };
          workloadCheck(
            response.status === 202 && accepted.status === "queued" && typeof accepted.runId === "string",
            "Real turn was not queued",
          );
          runId = accepted.runId;
        }
        workloadCheck(runId, "Producer run ID is missing");
        const owned = await client.query("SELECT session_id FROM runs WHERE id=$1", [runId]);
        workloadCheck(
          owned.rows[0]?.session_id === body.conversation.threadRef,
          "Queued run did not reach fixture database",
        );
        ownedRun = true;
        event({
          type: "producer-accepted",
          name: lane.name,
          origin: lane.origin,
          nonce: matched[2],
          runId,
          startedAt,
          acceptedAt: Date.now(),
          ...(history ? { historySessionId: history.sessionId, historyCohort: lane.history!.name } : {}),
          ...(cronId ? { cronId, firstFireAt } : {}),
          requestBytes: Buffer.byteLength(requestBody),
          requestGzipBytes: gzipSync(requestBody).byteLength,
        });
        const acceptedRunId = runId;
        streamTasks = Array.from({ length: lane.subscribers }, async (_, subscriber) => {
          const streamPath = `/v1/runs/${encodeURIComponent(acceptedRunId)}/events`;
          const stream = await fetcher(new URL(streamPath, profile.workload.baseUrl), { signal, redirect: "error" });
          activeStreams++;
          event({ type: "producer-stream-open", name: lane.name, runId, subscriber, activeStreams });
          try {
            await consumeRunStream(stream, acceptedRunId, signal, (record, size) => {
              bytes += size;
              events++;
              const at = Date.now();
              if (at >= measuredStart && at < measuredEnd) {
                measuredEvents++;
                measuredBytes += size;
              }
              event({
                type: "producer-event",
                name: lane.name,
                runId,
                subscriber,
                eventType: record.type,
                eventName: record.name,
                bytes: size,
              });
            });
          } finally {
            activeStreams--;
            event({ type: "producer-stream-close", name: lane.name, runId, subscriber, activeStreams });
          }
        });
        await Promise.all(streamTasks);
        const completed = await client.query(
          "SELECT r.status,r.started_at,r.finished_at,s.id AS session_id,count(l.id)::int AS llm_calls FROM runs r LEFT JOIN sessions s ON s.thread_ref=r.session_id LEFT JOIN session_llm_requests l ON l.session_id=s.id AND l.created_at BETWEEN r.created_at AND r.finished_at WHERE r.id=$1 GROUP BY r.id,s.id",
          [runId],
        );
        workloadCheck(
          completed.rows[0]?.status === "done" &&
            completed.rows[0]?.llm_calls === shape.modelCalls &&
            (!history || completed.rows[0]?.session_id === history.sessionId),
          "Actual model calls/run status/history session do not match the producer shape",
        );
        if (cronId) {
          for (;;) {
            signal.throwIfAborted();
            const fires = await client.query(
              "SELECT fire_key,scheduled_at,fired_at,ended_at,status FROM cron_fires WHERE cron_id=$1",
              [cronId],
            );
            const jobs = await client.query(
              "SELECT id,state,data,created_on,started_on,completed_on FROM pgboss.job WHERE name='cron-fire' AND data->>'cronId'=$1",
              [cronId],
            );
            workloadCheck(fires.rows.length === 1 && jobs.rows.length === 1, "Native cron fire/job count mismatch");
            const fire = fires.rows[0]!,
              job = jobs.rows[0]!;
            workloadCheck(!["failed", "cancelled"].includes(job.state), "Native scheduler job failed");
            if (fire.ended_at && job.state === "completed") {
              workloadCheck(
                fire.status === "ok" && job.data.scheduledAt === firstFireAt,
                "Native cron terminal evidence mismatch",
              );
              event({ type: "producer-cron-terminal", name: lane.name, cronId, runId, firstFireAt, fire, job });
              cronTerminals++;
              break;
            }
            await sleep(100, undefined, { signal });
          }
        }
        event({
          type: "producer-run-complete",
          name: lane.name,
          origin: lane.origin,
          runId,
          nonce: matched[2],
          startedAt,
          finishedAt: Date.now(),
          bytes,
          events,
          database: completed.rows[0],
        });
        completedByLane.set(lane.name, (completedByLane.get(lane.name) ?? 0) + 1);
        return new Response("", { status: 200 });
      } catch (error) {
        stop.abort();
        await Promise.allSettled(streamTasks);
        event({
          type: "producer-run-failed",
          name: lane.name,
          origin: lane.origin,
          runId,
          cronId,
          startedAt,
          finishedAt: Date.now(),
          bytes,
          events,
          error: error instanceof Error ? error.message : "Run failed",
        });
        if (ownedRun && runId) {
          const path = `/v1/runs/${encodeURIComponent(runId)}/signal`;
          const aborted = await fetcher(new URL(path, profile.workload.baseUrl), {
            method: "POST",
            body: JSON.stringify({ kind: "abort" }),
            signal: AbortSignal.timeout(5000),
            redirect: "error",
          }).catch(() => null);
          event({ type: "producer-abort", name: lane.name, runId, accepted: aborted?.ok ?? false });
          await aborted?.arrayBuffer();
        }
        throw error;
      } finally {
        if (history) busyHistory.delete(history.threadRef);
        if (cronId) {
          await disableCron(cronId, lane.principalId).catch(() => {
            cleanupErrors++;
            event({ type: "producer-cron-disable-failed", name: lane.name, cronId });
          });
        }
      }
    };
    let before: Awaited<ReturnType<typeof counterSnapshot>> | undefined;
    let after: Awaited<ReturnType<typeof counterSnapshot>> | undefined;
    let counterStart: Promise<void> | undefined;
    let counterEnd: Promise<void> | undefined;
    const measuredProfile = producerWorkload(profile, provider, "measured");
    const run = (workload: WorkloadProfile, measured: boolean) =>
      runWorkload(workload, fixture, {
        fetcher,
        dispatchTurn,
        env,
        emit: (record) => {
          if (record.type === "measurement-start")
            phaseStarts.set(measured ? "measured" : "warmup", Number(record.startedAt));
          event({
            ...record,
            phase: measured ? "measured" : "warmup",
            ...(record.type === "summary" ? { type: "scheduler-summary" } : {}),
          });
          if (!measured) return;
          if (record.type === "measurement-start") {
            measuredStart = Number(record.startedAt);
            measuredEnd = Number(record.plannedFinishAt);
            counterStart = counterSnapshot()
              .then((value) => {
                before = value;
              })
              .catch(() => {
                observerErrors++;
              });
            sampling = setInterval(() => {
              if (!observing) {
                observing = sample().finally(() => {
                  observing = null;
                });
              }
            }, 1000);
            observing = sample().finally(() => {
              observing = null;
            });
          }
          if (record.type === "measurement-end") {
            clearInterval(sampling);
            counterEnd = counterSnapshot()
              .then((value) => {
                after = value;
              })
              .catch(() => {
                observerErrors++;
              });
          }
        },
      });
    let warmup: ReturnType<typeof run> | undefined;
    if (profile.warmupMs) {
      let opened!: () => void;
      const ready = new Promise<void>((resolve) => {
        opened = resolve;
      });
      warmup = runWorkload(
        { ...producerWorkload(profile, provider, "warmup"), durationMs: profile.warmupMs },
        fixture,
        {
          fetcher,
          dispatchTurn,
          env,
          emit: (record) => {
            if (record.type === "measurement-start") phaseStarts.set("warmup", Number(record.startedAt));
            event({ ...record, type: record.type === "summary" ? "scheduler-summary" : record.type, phase: "warmup" });
            if (record.type === "measurement-end") opened();
          },
        },
      );
      await Promise.race([ready, warmup.then(() => {})]);
    }
    const summary = await run(measuredProfile, true);
    const warmed = await warmup;
    await Promise.all([counterStart, counterEnd, observing]);
    workloadCheck(before && after, "Missing measurement counter snapshots");
    const rates = writeRates(before.rows, after.rows, (after.at - before.at) / 1000);
    const seconds = profile.workload.durationMs / 1000;
    const providerAfter = await twinSnapshot();
    const inWindow = gauges.filter((item) => item.at >= measuredStart && item.at < measuredEnd);
    const checks = {
      scheduler: summary.pass && (!warmed || warmed.pass),
      counters: rates.every((row) => {
        const b = profile.bounds.writes[row.table];
        return (
          b && inBound(row.inserts, b.inserts) && inBound(row.updates, b.updates) && inBound(row.deletes, b.deletes)
        );
      }),
      running: inWindow.length > 0 && inWindow.every((row) => inBound(row.running, profile.bounds.running)),
      events: inBound(measuredEvents / seconds, profile.bounds.runEventsPerSecond),
      bytes: inBound(measuredBytes / seconds, profile.bounds.runBytesPerSecond),
      observers: observerErrors === 0 && after.at - before.at >= profile.workload.durationMs - 1000,
      cleanup: cleanupErrors === 0 && createdCrons.size === 0,
      provider:
        providerAfter.totals.calls > providerIdentity.totals.calls &&
        providerAfter.totals.errors === providerIdentity.totals.errors,
    };
    const result = {
      ...summary,
      workloadProfileSha256: producerProfileSha256,
      type: "summary",
      pass: Object.values(checks).every(Boolean),
      qualified: false,
      producer: {
        kind: "controlled-envelope",
        checks,
        rates,
        counterStart: before.at,
        counterEnd: after.at,
        runningSamples: inWindow.length,
        measuredEvents,
        measuredBytes,
        eventsPerSecond: measuredEvents / seconds,
        bytesPerSecond: measuredBytes / seconds,
        evidence: profile.evidence,
        coverage: {
          historyAttestations,
          verifiedReadFiles: verifiedFiles.size,
          nativeCronTerminals: cronTerminals,
          lanes: profile.lanes.map((lane) => ({
            name: lane.name,
            origin: lane.origin,
            historyCohort: lane.history?.name ?? null,
            historySessions: lane.history?.sessions.length ?? 0,
            completedIncludingWarmup: completedByLane.get(lane.name) ?? 0,
          })),
        },
        qualificationGaps: [
          ...PRODUCER_QUALIFICATION_GAPS,
          ...(!profile.lanes.some((lane) => lane.history) ? ["existing-history-workload"] : []),
          ...(!profile.lanes.some((lane) => lane.origin === "cron") ? ["native-cron-scheduling"] : []),
        ],
        limitations: [
          "Direct turns use a synthetic web surface; Slack ingress/delivery and auxiliary model traffic are not replayed",
          "Native cron lanes use new one-shot schedules with declared lead times; recurring-calendar/retained-schedule parity needs independent evidence",
          "Existing-history cohorts add read-only database attestations at preflight and each arrival; observer overhead is part of this envelope",
          "Files(action read) replaces external tool work; sandbox/external latency and resource parity require independent evidence",
          "Configured rates or recorded arrival offsets form a controlled envelope; trace fidelity depends on the retained source resolution and shape evidence",
          "Database counters are server-reported cumulative statistics and can lag commits",
        ],
      },
    };
    event(result as unknown as Record<string, unknown>);
    return result;
  } finally {
    clearInterval(sampling);
    await observing;
    for (const [cronId, principalId] of createdCrons) {
      await disableCron(cronId, principalId).catch(() => event({ type: "producer-cron-cleanup-unresolved", cronId }));
    }
    await client.end();
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      profile: { type: "string" },
      provider: { type: "string" },
      fixture: { type: "string" },
      out: { type: "string" },
    },
  });
  workloadCheck(
    values.profile && values.provider && values.fixture && values.out,
    "Pass --profile, --provider, --fixture and --out",
  );
  const profile = JSON.parse(readFileSync(values.profile, "utf8")) as ProducerProfile;
  const provider = JSON.parse(readFileSync(values.provider, "utf8")) as ProviderProfile;
  const fixture = JSON.parse(readFileSync(values.fixture, "utf8")) as WorkloadFixture;
  validateProducer(profile, fixture, provider);
  const fd = openSync(values.out, "wx", 0o600);
  try {
    const result = await runProducer(profile, fixture, provider, (record) => {
      writeSync(fd, JSON.stringify(record) + "\n");
      if (record.type === "measurement-start" && record.phase === "measured")
        process.stdout.write(JSON.stringify(record) + "\n");
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = result.pass ? 0 : 1;
  } finally {
    closeSync(fd);
  }
}
