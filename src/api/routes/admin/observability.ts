import { parseScopeId, type ScopeId } from "../../../types.ts";
import { cacheHitRatio, isStablePrefixMiss, type TurnMetricSample } from "../../../admin/metrics-sink.ts";
import { sendJson } from "../../http.ts";
import { audit, requireScopedAdmin } from "../shared.ts";
import { type ApiCtx } from "../route.ts";

const METRICS_SCAN_LIMIT = 10000;
const METRICS_RUNS_SCAN_LIMIT = 500;
const PHASE_DIST_EDGES_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];
const PHASE_WORST_LIMIT = 8;
const EGRESS_LIST_LIMIT = 1000;
const RUNS_LIST_LIMIT = 200;
const ERRORS_LIST_LIMIT = 200;
const AUDIT_TAIL_LIMIT = 200;

function latencySummary(values: number[]): {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const pct = (p: number): number | null => {
    if (!sorted.length) return null;
    const rank = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, rank))]!;
  };
  return { count: sorted.length, p50: pct(50), p95: pct(95), p99: pct(99) };
}

export async function metrics(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  audit(deps, { principalId: actor.id, action: "metrics.read", resource: "metrics", scopeLabel: scope });
  const orgWide = parseScopeId(scope).kind === "org";

  const allSamples =
    (await deps.metrics?.list({ limit: METRICS_SCAN_LIMIT, ...(orgWide ? {} : { scopeId: scope }) })) ?? [];
  const captureSamples = allSamples.filter((s) => s.status === "capture");
  const samples = allSamples.filter((s) => s.status !== "capture");
  const ttft = latencySummary(samples.map((s) => s.ttftMs).filter((n): n is number => typeof n === "number"));
  const turnLatency = latencySummary(samples.map((s) => s.totalMs));

  const byDay = new Map<string, { ttfts: number[]; turns: number }>();
  for (const s of samples) {
    const day = new Date(s.ts).toISOString().slice(0, 10);
    const bucket = byDay.get(day) ?? { ttfts: [], turns: 0 };
    bucket.turns += 1;
    if (typeof s.ttftMs === "number") bucket.ttfts.push(s.ttftMs);
    byDay.set(day, bucket);
  }
  const series = [...byDay.entries()]
    .sort(([a], [b]) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    })
    .map(([day, b]) => {
      const t = latencySummary(b.ttfts);
      return { day, turns: b.turns, ttftP50: t.p50, ttftP95: t.p95 };
    });

  const allRuns = (await deps.runs?.list({ limit: METRICS_RUNS_SCAN_LIMIT })) ?? [];
  const runScopes = orgWide
    ? null
    : new Map(
        ((await deps.sessions?.sessionsByThreadRefs(allRuns.map((r) => r.sessionId))) ?? []).map((s) => [
          s.threadRef,
          s.scopeId,
        ]),
      );
  const runs = allRuns.filter((r) => orgWide || runScopes!.get(r.sessionId) === scope);
  const queueWait = latencySummary(runs.filter((r) => r.startedAt != null).map((r) => r.startedAt! - r.createdAt));
  const runLatency = latencySummary(
    runs.filter((r) => r.startedAt != null && r.finishedAt != null).map((r) => r.finishedAt! - r.startedAt!),
  );
  const done = runs.filter((r) => r.status === "done").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const finished = done + failed;
  const throughput = { total: runs.length, done, failed, failureRate: finished ? failed / finished : 0 };

  const pick = (rows: TurnMetricSample[], f: (s: TurnMetricSample) => number | undefined): number[] =>
    rows.map(f).filter((n): n is number => typeof n === "number");
  const stat = (xs: number[]): ReturnType<typeof latencySummary> & { avg: number | null } => ({
    ...latencySummary(xs),
    avg: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null,
  });
  const traceATurns = samples.filter((s) => s.provisioned === false);
  const traceBTurns = samples.filter((s) => s.provisioned === true);
  const coldTurns = traceBTurns.filter((s) => s.coldStart === true);
  const warmTurns = traceBTurns.filter((s) => s.coldStart === false);
  const classifiedTurns = traceATurns.concat(traceBTurns);
  const anatomy = {
    traceA: {
      samples: traceATurns.length,
      total: stat(pick(traceATurns, (s) => s.totalMs)),
      ttft: stat(pick(traceATurns, (s) => s.ttftMs)),
      stream: stat(pick(traceATurns, (s) => s.streamMs)),
      lease: stat(pick(traceATurns, (s) => s.leaseMs)),
      recall: stat(pick(traceATurns, (s) => s.recallMs)),
      modelCalls: stat(pick(traceATurns, (s) => s.modelCalls)),
      toolCalls: stat(pick(traceATurns, (s) => s.toolCalls)),
    },
    traceB: {
      samples: traceBTurns.length,
      cold: coldTurns.length,
      warm: warmTurns.length,
      total: stat(pick(traceBTurns, (s) => s.totalMs)),
      ttft: stat(pick(traceBTurns, (s) => s.ttftMs)),
      provision: stat(pick(traceBTurns, (s) => s.provisionMs)),
      provisionCold: stat(pick(coldTurns, (s) => s.provisionMs)),
      provisionWarm: stat(pick(warmTurns, (s) => s.provisionMs)),
      materialize: stat(pick(traceBTurns, (s) => s.materializeMs)),
      exec: stat(pick(traceBTurns, (s) => s.execMs)),
      recall: stat(pick(traceBTurns, (s) => s.recallMs)),
      modelCalls: stat(pick(traceBTurns, (s) => s.modelCalls)),
      toolCalls: stat(pick(traceBTurns, (s) => s.toolCalls)),
    },
    composite: {
      totalTurns: classifiedTurns.length,
      provisionedTurns: traceBTurns.length,
      provisionRate: classifiedTurns.length ? traceBTurns.length / classifiedTurns.length : 0,
      coldRate: traceBTurns.length ? coldTurns.length / traceBTurns.length : 0,
      total: stat(pick(classifiedTurns, (s) => s.totalMs)),
      modelCalls: stat(pick(classifiedTurns, (s) => s.modelCalls)),
      toolCalls: stat(pick(classifiedTurns, (s) => s.toolCalls)),
    },
    capture: stat(pick(captureSamples, (s) => s.captureMs)),
  };

  const ratios = samples.map((s) => cacheHitRatio(s)).filter((r): r is number => r !== null);
  const missFlags = samples.map((s) => isStablePrefixMiss(s)).filter((m): m is boolean => m !== null);
  const misses = missFlags.filter((m) => m).length;
  const cacheReadTotal = samples.reduce((n, s) => n + (s.cacheRead ?? 0), 0);
  const cacheWriteTotal = samples.reduce((n, s) => n + (s.cacheWrite ?? 0), 0);
  const uncachedInputTotal = samples.reduce((n, s) => n + (s.uncachedInput ?? 0), 0);
  const cache = {
    samples: ratios.length,
    avgHitRatio: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null,
    pooledHitRatio:
      cacheReadTotal + cacheWriteTotal + uncachedInputTotal > 0
        ? cacheReadTotal / (cacheReadTotal + cacheWriteTotal + uncachedInputTotal)
        : null,
    missTurns: misses,
    missRate: missFlags.length ? misses / missFlags.length : null,
    cacheReadTotal,
    cacheWriteTotal,
    uncachedInputTotal,
  };

  const phaseFields: [string, (s: TurnMetricSample) => number | undefined][] = [
    ["total", (s) => s.totalMs],
    ["ttft", (s) => s.ttftMs],
    ["slackInflight", (s) => s.slackInflightMs],
    ["intakePreamble", (s) => s.intakePreambleMs],
    ["queue", (s) => s.queueMs],
    ["dispatch", (s) => s.dispatchMs],
    ["ingress", (s) => s.ingressMs],
    ["detect", (s) => s.detectMs],
    ["compact", (s) => s.compactMs],
    ["provision", (s) => s.provisionMs],
    ["materialize", (s) => s.materializeMs],
    ["creds", (s) => s.credsMs],
    ["layers", (s) => s.layersMs],
    ["compile", (s) => s.compileMs],
    ["recall", (s) => s.recallMs],
    ["lease", (s) => s.leaseMs],
    ["exec", (s) => s.execMs],
    ["stream", (s) => s.streamMs],
    ["deliver", (s) => s.deliverMs],
    ["capture", (s) => s.captureMs],
  ];
  const phases = phaseFields.map(([phase, f]) => {
    const rows = (phase === "capture" ? captureSamples : samples)
      .map((s) => ({ s, v: f(s) }))
      .filter((r): r is { s: TurnMetricSample; v: number } => Number.isFinite(r.v));
    const byPhaseDay = new Map<string, number[]>();
    const bucketCounts = Array.from({ length: PHASE_DIST_EDGES_MS.length + 1 }, () => 0);
    for (const r of rows) {
      const day = new Date(r.s.ts).toISOString().slice(0, 10);
      const xs = byPhaseDay.get(day) ?? [];
      xs.push(r.v);
      byPhaseDay.set(day, xs);
      const bucket = PHASE_DIST_EDGES_MS.findIndex((le) => r.v <= le);
      const idx = bucket === -1 ? PHASE_DIST_EDGES_MS.length : bucket;
      bucketCounts[idx] = (bucketCounts[idx] ?? 0) + 1;
    }
    const daily = [...byPhaseDay.entries()]
      .sort(([a], [b]) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
      })
      .map(([day, xs]) => ({ day, ...latencySummary(xs) }));
    const dist = bucketCounts.map((count, i) => ({
      le: i < PHASE_DIST_EDGES_MS.length ? PHASE_DIST_EDGES_MS[i]! : null,
      count,
    }));
    const worst = rows
      .slice()
      .sort((a, b) => b.v - a.v)
      .slice(0, PHASE_WORST_LIMIT)
      .map(({ s, v }) => ({
        ms: v,
        ts: s.ts,
        totalMs: s.totalMs,
        sessionId: s.sessionId ?? null,
        turnSeq: s.turnSeq ?? null,
        scopeLabel: s.scopeLabel,
        provisioned: s.provisioned ?? null,
        coldStart: s.coldStart ?? null,
      }));
    return { phase, ...latencySummary(rows.map((r) => r.v)), daily, dist, worst };
  });

  return sendJson(res, 200, {
    scopeId: scope,
    ttft,
    turnLatency,
    runLatency,
    queueWait,
    throughput,
    series,
    anatomy,
    cache,
    phases,
  });
}

export async function egress(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  audit(deps, { principalId: actor.id, action: "egress.read", resource: "egress", scopeLabel: scope });
  const orgWide = parseScopeId(scope).kind === "org";
  const q = orgWide ? { limit: EGRESS_LIST_LIMIT } : { scopeId: scope, limit: EGRESS_LIST_LIMIT };
  const brokerRows = ((await deps.credentialUsage?.list(q)) ?? []).map((s) => ({
    ts: s.ts,
    source: "broker" as string,
    host: s.host,
    scopeLabel: s.scopeLabel,
    principalId: s.principalId,
    allowed: s.status !== "denied",
    status: s.status,
    slug: s.slug,
    ...(s.upstreamStatus !== undefined ? { upstreamStatus: s.upstreamStatus } : {}),
  }));
  const firewallRows = ((await deps.egressAudit?.list(q)) ?? []).map((e) => ({
    ts: e.ts,
    source: e.source,
    host: e.host,
    scopeLabel: e.scopeLabel,
    allowed: e.allowed,
    status: e.verdict ?? (e.allowed ? "ok" : "denied"),
    ...(e.principalId !== undefined ? { principalId: e.principalId } : {}),
    ...(e.port !== undefined ? { port: e.port } : {}),
    ...(e.via !== undefined ? { via: e.via } : {}),
    ...(e.peerIp !== undefined ? { peerIp: e.peerIp } : {}),
  }));
  const records = [...brokerRows, ...firewallRows].sort((a, b) => b.ts - a.ts).slice(0, EGRESS_LIST_LIMIT);
  const denied = records.filter((r) => !r.allowed).length;
  const hosts = new Set(records.map((r) => r.host).filter(Boolean)).size;
  const bySource = { broker: brokerRows.length, firewall: firewallRows.length };
  return sendJson(res, 200, { scopeId: scope, records, total: records.length, denied, hosts, bySource });
}

export async function listAdminRuns(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  audit(deps, { principalId: actor.id, action: "runs.read", resource: "runs", scopeLabel: scope });
  const orgWide = parseScopeId(scope).kind === "org";
  const rawRuns = (await deps.runs?.list({ limit: RUNS_LIST_LIMIT })) ?? [];
  const byThread = new Map(
    ((await deps.sessions?.sessionsByThreadRefs(rawRuns.map((r) => r.sessionId))) ?? []).map((s) => [s.threadRef, s]),
  );
  const ACTIVE = new Set(["pending", "running"]);
  const runs = rawRuns
    .map((r) => {
      const s = byThread.get(r.sessionId);
      return {
        id: r.id,
        status: r.status,
        sessionScope: s?.scopeId ?? null,
        sessionType: s?.type ?? null,
        threadRef: r.sessionId,
        attempts: r.attempts,
        maxAttempts: r.maxAttempts,
        workerId: r.workerId,
        leaseExpiresAt: r.leaseExpiresAt,
        createdAt: r.createdAt,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
      };
    })
    .filter((r) => orgWide || r.sessionScope === scope)
    .sort((a, b) => Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status)) || b.createdAt - a.createdAt);
  return sendJson(res, 200, { scopeId: scope, active: runs.filter((r) => ACTIVE.has(r.status)).length, runs });
}

export async function listAdminErrors(ctx: ApiCtx): Promise<void> {
  const { res, deps, url } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  audit(deps, { principalId: actor.id, action: "errors.read", resource: "errors", scopeLabel: scope });
  const orgWide = parseScopeId(scope).kind === "org";
  const sessionId = url.searchParams.get("sessionId") || undefined;
  if (url.searchParams.get("count")) {
    const total =
      (await deps.errors?.count({
        ...(orgWide ? {} : { scopeId: scope }),
        ...(sessionId ? { sessionId } : {}),
      })) ?? 0;
    return sendJson(res, 200, { scopeId: scope, total });
  }
  const fromLog =
    (await deps.errors?.list({
      ...(orgWide ? {} : { scopeId: scope }),
      ...(sessionId ? { sessionId } : {}),
    })) ?? [];
  const errors = [...fromLog].sort((a, b) => b.ts - a.ts).slice(0, ERRORS_LIST_LIMIT);
  return sendJson(res, 200, { scopeId: scope, errors });
}

export async function listAdminAudit(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  audit(deps, { principalId: actor.id, action: "audit.read", resource: "audit", scopeLabel: scope });
  const orgWide = parseScopeId(scope).kind === "org";
  const events = (
    (await deps.auditLog?.tail({
      limit: AUDIT_TAIL_LIMIT,
      ...(orgWide ? {} : { scopeLabel: scope as ScopeId }),
    })) ?? []
  ).map((e) => ({
    ts: e.at,
    principalId: e.principalId,
    action: e.action,
    scopeLabel: e.scopeLabel,
    resource: e.resource,
    ...(e.status ? { status: e.status } : {}),
  }));
  return sendJson(res, 200, { scopeId: scope, events });
}
