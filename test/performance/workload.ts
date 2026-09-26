import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

export interface WorkloadFixture {
  schemaVersion: number;
  fixtureId: string;
  databaseName: string;
  profileSha256: string;
  qualified: boolean;
  [key: string]: unknown;
}

interface Endpoint {
  name: string;
  path: string;
  headers?: Record<string, string>;
  headersEnv?: Record<string, string>;
}

export interface RequestPlan extends Endpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  ratePerSecond: number;
  arrivalOffsetsMs?: number[];
  body?: unknown;
  expectedStatuses?: number[];
}

interface StreamPlan extends Endpoint {
  connections: number;
}

export interface WorkloadProfile {
  schemaVersion: 1;
  baseUrl: string;
  fixtureId: string;
  isolated: true;
  externalEffectsDisabled: true;
  mode: "diagnostic" | "qualifying";
  condition: string;
  durationMs: number;
  requestTimeoutMs: number;
  maxConcurrency: number;
  maxStartDelayMs: number;
  streamConnectTimeoutMs: number;
  requests: RequestPlan[];
  streams: StreamPlan[];
}

interface RequestStats {
  offered: number;
  started: number;
  completed: number;
  completedInWindow: number;
  succeeded: number;
  errors: number;
  missed: number;
  late: number;
  maxLatenessMs: number;
  maxConcurrency: number;
  active: number;
}

export interface WorkloadSummary {
  type: "summary";
  runId: string;
  fixtureId: string;
  profileSha256: string;
  workloadProfileSha256: string;
  condition: string;
  mode: WorkloadProfile["mode"];
  qualified: boolean;
  pass: boolean;
  startedAt: number;
  finishedAt: number;
  drainedAt: number;
  plannedFinishAt: number;
  cancelledAt: number | null;
  measurementComplete: boolean;
  schedulerEndLatenessMs: number;
  maxConcurrency: number;
  requests: Array<
    RequestStats & {
      name: string;
      targetRate: number;
      offeredRate: number;
      startedRate: number;
      successfulRate: number;
      completedRate: number;
    }
  >;
  streams: {
    expected: number;
    opened: number;
    maxActive: number;
    minActive: number;
    errors: number;
    events: number;
    bytes: number;
  };
}

type Emit = (record: Record<string, unknown>) => void;

function checked(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function arrivalOffsetMs(
  plan: Pick<RequestPlan, "ratePerSecond" | "arrivalOffsetsMs">,
  sequence: number,
): number {
  if (plan.arrivalOffsetsMs) return plan.arrivalOffsetsMs[sequence] ?? Infinity;
  return plan.ratePerSecond ? (sequence * 1000) / plan.ratePerSecond : Infinity;
}

function endpointUrl(base: URL, path: string): string {
  checked(path.startsWith("/") && !path.startsWith("//"), "Paths must start with a single slash");
  const target = new URL(path, base);
  checked(target.origin === base.origin && !target.hash, "Every endpoint must remain on the fixture origin");
  return target.href;
}

function replaceValues(
  value: unknown,
  fixture: WorkloadFixture,
  runId: string,
  sequence: number,
  encode: boolean,
): unknown {
  if (typeof value === "string")
    return value.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_match, key: string) => {
      let found: unknown = fixture;
      if (key === "sequence") found = sequence;
      if (key === "runId") found = runId;
      if (key !== "sequence" && key !== "runId")
        for (const part of key.split(".")) {
          checked(
            found !== null && typeof found === "object" && Object.hasOwn(found, part),
            `Unknown fixture value: ${key}`,
          );
          found = (found as Record<string, unknown>)[part];
        }
      checked(["string", "number", "boolean"].includes(typeof found), `Fixture value must be scalar: ${key}`);
      return encode ? encodeURIComponent(String(found)) : String(found);
    });
  if (Array.isArray(value)) return value.map((item) => replaceValues(item, fixture, runId, sequence, encode));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceValues(item, fixture, runId, sequence, encode)]),
    );
  return value;
}

function headersFor(plan: Endpoint, env: NodeJS.ProcessEnv): Headers {
  const headers = new Headers(plan.headers);
  for (const [name, variable] of Object.entries(plan.headersEnv ?? {})) {
    checked(env[variable], `Missing environment variable: ${variable}`);
    headers.set(name, env[variable]!);
  }
  checked(!headers.has("host"), "Host headers cannot override the fixture origin");
  return headers;
}

export function validateWorkload(
  profile: WorkloadProfile,
  fixture: WorkloadFixture,
  env: NodeJS.ProcessEnv = process.env,
  guardedTurnDispatch = false,
): URL {
  checked(profile.schemaVersion === 1 && fixture.schemaVersion === 1, "Unsupported schema version");
  checked(
    profile.isolated === true && profile.externalEffectsDisabled === true,
    "Replay requires explicit isolated fixture and disabled external effects",
  );
  checked(profile.fixtureId === fixture.fixtureId && fixture.fixtureId.length > 0, "Fixture ID mismatch");
  checked(
    typeof fixture.profileSha256 === "string" && fixture.profileSha256.length > 0,
    "Fixture population hash is required",
  );
  checked(/^qm_perf_[a-zA-Z0-9_]+$/.test(fixture.databaseName), "Replay requires a qm_perf_ fixture database");
  checked(profile.mode === "diagnostic" || profile.mode === "qualifying", "Specify diagnostic or qualifying mode");
  checked(
    profile.mode !== "qualifying" || fixture.qualified === true,
    "Qualifying replay requires a qualified population fixture",
  );
  checked(typeof profile.condition === "string" && profile.condition.length > 0, "A load condition label is required");
  const base = new URL(profile.baseUrl);
  checked(
    ["http:", "https:"].includes(base.protocol) &&
      !base.username &&
      !base.password &&
      base.pathname === "/" &&
      !base.search &&
      !base.hash,
    "baseUrl must be an HTTP origin without credentials or path",
  );
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  checked(
    local || env.QM_PERFORMANCE_ALLOWED_ORIGIN === base.origin,
    "Remote replay requires QM_PERFORMANCE_ALLOWED_ORIGIN matching the isolated origin exactly",
  );
  for (const key of [
    "durationMs",
    "requestTimeoutMs",
    "maxConcurrency",
    "maxStartDelayMs",
    "streamConnectTimeoutMs",
  ] as const)
    checked(Number.isSafeInteger(profile[key]) && profile[key] > 0, `${key} must be a positive integer`);
  checked(Array.isArray(profile.requests) && Array.isArray(profile.streams), "requests and streams must be arrays");
  const names = new Set<string>();
  for (const plan of [...profile.requests, ...profile.streams]) {
    checked(
      typeof plan.name === "string" && plan.name.length > 0 && !names.has(plan.name),
      "Every request and stream needs a unique name",
    );
    names.add(plan.name);
    const path = replaceValues(plan.path, fixture, "validation", 0, true) as string;
    endpointUrl(base, path);
    headersFor(plan, env);
    if ("method" in plan) {
      checked(["GET", "POST", "PUT", "PATCH", "DELETE"].includes(plan.method), "Unsupported HTTP method");
      checked(Number.isFinite(plan.ratePerSecond) && plan.ratePerSecond >= 0, "Request rates must be nonnegative");
      if (plan.arrivalOffsetsMs !== undefined)
        checked(
          plan.ratePerSecond === 0 &&
            Array.isArray(plan.arrivalOffsetsMs) &&
            plan.arrivalOffsetsMs.every(
              (at, i, offsets) =>
                Number.isSafeInteger(at) && at >= 0 && at < profile.durationMs && (i === 0 || at >= offsets[i - 1]!),
            ),
          "Recorded arrivals require rate zero and ordered integer offsets inside the measurement window",
        );
      checked(plan.method !== "GET" || plan.body === undefined, "GET requests cannot have a body");
      checked(
        plan.method === "GET" ||
          (guardedTurnDispatch && plan.method === "POST" && ["/api/turn", "/v1/turns?async=1"].includes(path)) ||
          !/^\/(?:api|v1)\/(?:runs|turns?|surface-post)(?:[/?]|$)/.test(path),
        "Workload replay does not dispatch model runs or surface posts",
      );
      checked(
        !plan.expectedStatuses ||
          (plan.expectedStatuses.length > 0 &&
            plan.expectedStatuses.every(
              (status) =>
                Number.isInteger(status) && ((status >= 200 && status < 300) || (status >= 400 && status < 500)),
            )),
        "Expected statuses must be explicit success or client-denial HTTP statuses",
      );
      replaceValues(plan.body, fixture, "validation", 0, false);
    } else
      checked(
        Number.isInteger(plan.connections) && plan.connections >= 0,
        "Stream connections must be nonnegative integers",
      );
  }
  checked(
    profile.requests.some((plan) => plan.ratePerSecond > 0 || plan.arrivalOffsetsMs?.length) ||
      profile.streams.some((plan) => plan.connections > 0),
    "The workload must offer requests or streams",
  );
  return base;
}

export async function runWorkload(
  profile: WorkloadProfile,
  fixture: WorkloadFixture,
  options: {
    emit: Emit;
    fetcher?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    dispatchTurn?: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<WorkloadSummary> {
  const env = options.env ?? process.env;
  const base = validateWorkload(profile, fixture, env, Boolean(options.dispatchTurn));
  const fetcher = options.fetcher ?? fetch;
  const runId = randomUUID();
  const identity = {
    schemaVersion: 1,
    runId,
    fixtureId: fixture.fixtureId,
    profileSha256: fixture.profileSha256,
    workloadProfileSha256: createHash("sha256").update(JSON.stringify(profile)).digest("hex"),
    condition: profile.condition,
  };
  const emit: Emit = (record) => options.emit({ ...identity, at: Date.now(), ...record });
  const startClock = performance.now();
  let measurementClock = startClock;
  let startedAt = Date.now();
  let finishedAt = startedAt;
  let schedulerEndLatenessMs = 0;
  let active = 0;
  let maxConcurrency = 0;
  let activeStreams = 0;
  let measuring = false;
  let stopping = false;
  const abortStreams = new AbortController();
  let cancelledAt: number | null = null;
  let cancelledClock = Infinity;
  const cancel = () => {
    cancelledAt ??= Date.now();
    cancelledClock = Math.min(cancelledClock, performance.now());
    stopping = true;
    abortStreams.abort();
  };
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const streams = {
    expected: profile.streams.reduce((sum, plan) => sum + plan.connections, 0),
    opened: 0,
    maxActive: 0,
    minActive: 0,
    errors: 0,
    events: 0,
    bytes: 0,
  };
  const gauge = () =>
    emit({ type: "gauge", activeRequests: active, activeStreams, expectedStreams: streams.expected, measuring });
  const requestStats = profile.requests.map((): RequestStats => ({
    offered: 0,
    started: 0,
    completed: 0,
    completedInWindow: 0,
    succeeded: 0,
    errors: 0,
    missed: 0,
    late: 0,
    maxLatenessMs: 0,
    maxConcurrency: 0,
    active: 0,
  }));
  const streamTasks: Promise<void>[] = [];
  const readiness: Promise<boolean>[] = [];
  for (const plan of options.signal?.aborted ? [] : profile.streams)
    for (let connection = 0; connection < plan.connections; connection++) {
      const ready = Promise.withResolvers<boolean>();
      readiness.push(ready.promise);
      streamTasks.push(
        (async () => {
          const connectAbort = new AbortController();
          const timer = setTimeout(() => connectAbort.abort(), profile.streamConnectTimeoutMs);
          const connectionStart = Date.now();
          let opened = false;
          let status: number | null = null;
          let error: string | null = null;
          let bytes = 0;
          let events = 0;
          try {
            const headers = headersFor(plan, env);
            headers.set("accept", "text/event-stream");
            const response = await fetcher(
              endpointUrl(base, replaceValues(plan.path, fixture, runId, connection, true) as string),
              { headers, redirect: "manual", signal: AbortSignal.any([abortStreams.signal, connectAbort.signal]) },
            );
            status = response.status;
            checked(
              response.status === 200 &&
                response.headers.get("content-type")?.split(";", 1)[0]?.trim() === "text/event-stream" &&
                response.body,
              "SSE connection failed",
            );
            clearTimeout(timer);
            opened = true;
            streams.opened++;
            activeStreams++;
            streams.maxActive = Math.max(streams.maxActive, activeStreams);
            emit({
              type: "stream-open",
              name: plan.name,
              connection,
              startedAt: connectionStart,
              finishedAt: Date.now(),
            });
            gauge();
            ready.resolve(true);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let prefix = "";
            let hasData = false;
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              const lines = (prefix + decoder.decode(chunk.value, { stream: true })).split("\n");
              prefix = (lines.pop() ?? "").slice(0, 5);
              for (const line of lines) {
                if (line === "" || line === "\r") {
                  if (hasData) events++;
                  hasData = false;
                } else if (line.startsWith("data:")) hasData = true;
              }
            }
            if (!stopping) throw new Error("SSE ended before the measurement finished");
          } catch {
            if (!stopping) {
              streams.errors++;
              error = opened ? "stream_ended" : "connection_failed";
            }
            ready.resolve(false);
          } finally {
            clearTimeout(timer);
            streams.bytes += bytes;
            streams.events += events;
            if (opened) activeStreams--;
            if (measuring) streams.minActive = Math.min(streams.minActive, activeStreams);
            emit({
              type: "stream-close",
              name: plan.name,
              connection,
              startedAt: connectionStart,
              finishedAt: Date.now(),
              status,
              error,
              bytes,
              events,
              expectedClose: stopping,
            });
            gauge();
          }
        })(),
      );
    }
  const connected =
    (await Promise.all(readiness)).every(Boolean) && activeStreams === streams.expected && !options.signal?.aborted;
  const pending = new Set<Promise<void>>();
  const next = profile.requests.map(() => 0);
  async function request(
    plan: RequestPlan,
    stats: RequestStats,
    sequence: number,
    scheduledMs: number,
    latenessMs: number,
  ): Promise<void> {
    active++;
    stats.active++;
    stats.started++;
    maxConcurrency = Math.max(maxConcurrency, active);
    stats.maxConcurrency = Math.max(stats.maxConcurrency, stats.active);
    const requestStart = performance.now();
    const requestEpoch = Date.now();
    let status: number | null = null;
    let headersMs: number | null = null;
    let bytes = 0;
    let error: string | null = null;
    try {
      const headers = headersFor(plan, env);
      if (plan.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
      const path = replaceValues(plan.path, fixture, runId, sequence, true) as string;
      const send =
        plan.method === "POST" && ["/api/turn", "/v1/turns?async=1"].includes(path) ? options.dispatchTurn : fetcher;
      checked(send, "Turn dispatch requires the guarded producer");
      const response = await send(endpointUrl(base, path), {
        method: plan.method,
        headers,
        body:
          plan.body === undefined
            ? undefined
            : JSON.stringify(replaceValues(plan.body, fixture, runId, sequence, false)),
        redirect: "manual",
        signal: AbortSignal.any([
          AbortSignal.timeout(profile.requestTimeoutMs),
          ...(options.signal ? [options.signal] : []),
        ]),
      });
      status = response.status;
      headersMs = performance.now() - requestStart;
      if (!(plan.expectedStatuses ?? [200]).includes(status)) error = "unexpected_status";
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
        }
      }
    } catch (caught) {
      if (options.signal?.aborted) error = "cancelled";
      else if (caught instanceof Error && ["TimeoutError", "AbortError"].includes(caught.name)) error = "timeout";
      else error = "request_failed";
    } finally {
      const doneClock = performance.now();
      stats.completed++;
      if (doneClock - measurementClock <= profile.durationMs && doneClock <= cancelledClock) stats.completedInWindow++;
      if (error) stats.errors++;
      else stats.succeeded++;
      active--;
      stats.active--;
      emit({
        type: "request",
        name: plan.name,
        sequence,
        scheduledAt: startedAt + scheduledMs,
        startedAt: requestEpoch,
        finishedAt: Date.now(),
        latenessMs,
        headersMs,
        durationMs: doneClock - requestStart,
        status,
        bytes,
        error,
        activeRequests: active,
      });
    }
  }
  if (connected) {
    measurementClock = performance.now();
    startedAt = Date.now();
    measuring = true;
    streams.minActive = activeStreams;
    emit({
      type: "measurement-start",
      startedAt,
      plannedFinishAt: startedAt + profile.durationMs,
      expectedStreams: streams.expected,
    });
    gauge();
    const gaugeTimer = setInterval(gauge, 1000);
    try {
      while (!options.signal?.aborted) {
        let earliest = profile.durationMs;
        for (let i = 0; i < profile.requests.length; i++) {
          if (options.signal?.aborted) break;
          const plan = profile.requests[i]!;
          const stats = requestStats[i]!;
          while (!options.signal?.aborted) {
            const scheduledMs = arrivalOffsetMs(plan, next[i]!);
            if (scheduledMs >= profile.durationMs) break;
            const nowMs = performance.now() - measurementClock;
            if (scheduledMs > nowMs) {
              earliest = Math.min(earliest, scheduledMs);
              break;
            }
            const sequence = next[i]!;
            next[i] = sequence + 1;
            stats.offered++;
            const latenessMs = Math.max(0, nowMs - scheduledMs);
            stats.maxLatenessMs = Math.max(stats.maxLatenessMs, latenessMs);
            let missed: string | null = null;
            if (active >= profile.maxConcurrency) missed = "concurrency_limit";
            if (nowMs >= profile.durationMs) missed = "window_ended";
            if (latenessMs > profile.maxStartDelayMs) missed = "late";
            if (missed) {
              stats.missed++;
              if (missed === "late") stats.late++;
              emit({
                type: "missed",
                name: plan.name,
                sequence,
                scheduledAt: startedAt + scheduledMs,
                latenessMs,
                reason: missed,
                activeRequests: active,
              });
            } else {
              const task = request(plan, stats, sequence, scheduledMs, latenessMs);
              pending.add(task);
              void task.finally(() => pending.delete(task));
            }
          }
        }
        const elapsed = performance.now() - measurementClock;
        if (elapsed >= profile.durationMs) break;
        try {
          await sleep(Math.max(0, earliest - elapsed), undefined, { signal: options.signal });
        } catch (error) {
          if (!options.signal?.aborted) throw error;
        }
      }
    } finally {
      clearInterval(gaugeTimer);
      schedulerEndLatenessMs = Math.max(0, performance.now() - measurementClock - profile.durationMs);
      finishedAt = Math.min(startedAt + profile.durationMs, cancelledAt ?? Infinity);
      measuring = false;
      emit({
        type: "measurement-end",
        startedAt,
        finishedAt,
        plannedFinishAt: startedAt + profile.durationMs,
        cancelledAt,
        actualStoppedAt: Date.now(),
        schedulerEndLatenessMs,
      });
      gauge();
    }
  }
  stopping = true;
  abortStreams.abort();
  await Promise.all([...streamTasks, ...pending]);
  options.signal?.removeEventListener("abort", cancel);
  const seconds = (finishedAt - startedAt) / 1000;
  const summary: WorkloadSummary = {
    ...identity,
    type: "summary",
    mode: profile.mode,
    qualified: fixture.qualified,
    pass:
      cancelledAt === null &&
      connected &&
      schedulerEndLatenessMs <= profile.maxStartDelayMs &&
      streams.errors === 0 &&
      streams.minActive === streams.expected &&
      requestStats.every((stats) => stats.errors === 0 && stats.missed === 0),
    startedAt,
    finishedAt,
    drainedAt: Date.now(),
    plannedFinishAt: startedAt + profile.durationMs,
    cancelledAt,
    measurementComplete: cancelledAt === null && connected && finishedAt === startedAt + profile.durationMs,
    schedulerEndLatenessMs,
    maxConcurrency,
    requests: requestStats.map((stats, i) => ({
      ...stats,
      name: profile.requests[i]!.name,
      targetRate: profile.requests[i]!.arrivalOffsetsMs
        ? profile.requests[i]!.arrivalOffsetsMs!.length / (profile.durationMs / 1000)
        : profile.requests[i]!.ratePerSecond,
      offeredRate: seconds > 0 ? stats.offered / seconds : 0,
      startedRate: seconds > 0 ? stats.started / seconds : 0,
      successfulRate: seconds > 0 ? stats.succeeded / seconds : 0,
      completedRate: seconds > 0 ? stats.completedInWindow / seconds : 0,
    })),
    streams,
  };
  emit(summary as unknown as Record<string, unknown>);
  return summary;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { profile: { type: "string" }, fixture: { type: "string" }, out: { type: "string" } },
    strict: true,
  });
  checked(
    values.profile && values.fixture && values.out,
    "Usage: node test/performance/workload.ts --profile profile.json --fixture fixture.json --out workload.jsonl",
  );
  const profile = JSON.parse(readFileSync(resolve(values.profile), "utf8")) as WorkloadProfile;
  const fixture = JSON.parse(readFileSync(resolve(values.fixture), "utf8")) as WorkloadFixture;
  validateWorkload(profile, fixture);
  const output = openSync(resolve(values.out), "wx", 0o600);
  try {
    const summary = await runWorkload(profile, fixture, {
      emit: (record) => {
        writeSync(output, JSON.stringify(record) + "\n");
        if (record.type === "measurement-start") process.stdout.write(JSON.stringify(record) + "\n");
      },
    });
    process.stdout.write(JSON.stringify(summary) + "\n");
    process.exitCode = summary.pass ? 0 : 1;
  } finally {
    closeSync(output);
  }
}
