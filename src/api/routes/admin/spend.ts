import { cacheHitRatio } from "../../../admin/metrics-sink.ts";
import { canonicalPerson } from "../../../directory/person.ts";
import { parseScopeId, personalScope, type Cron, type ScopeId } from "../../../types.ts";
import type { SessionOrigin, SessionStore, SpendRow } from "../../../sessions/session-store.ts";
import { constantTimeEqual } from "../../../util/crypto.ts";
import { contentDispositionAttachment, contentTypeWithUtf8Charset, sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import { discoverScopes } from "./common.ts";
import { type ApiCtx, type BaseCtx } from "../route.ts";

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 30;
const EXPORT_MAX_DAYS = 93;
const CRON_LOOKUP_CONCURRENCY = 8;
const SPEND_EXPORT_PRINCIPAL = "spend-export";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const EPOCH_MS = /^\d+$/;
const CSV_FORMULA_LEAD = /^[=+\-@\t\r]/;
const CSV_NEEDS_QUOTES = /["\r\n,]/;
const CSV_TOTALS_HEADER = [
  "live_usd",
  "background_usd",
  "cron_usd",
  "loop_usd",
  "swarm_usd",
  "webhook_usd",
  "monitor_usd",
  "total_usd",
  "calls",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cache_hit_ratio",
];

const SPEND_BREAKDOWNS = ["entity", "model", "cron"] as const;
type SpendBreakdown = (typeof SPEND_BREAKDOWNS)[number];
type SpendBucket = "day" | "week";
const BACKGROUND_SOURCES = ["cron", "loop", "swarm", "webhook", "monitor"] as const;
type BackgroundSource = (typeof BACKGROUND_SOURCES)[number];
type SpendSource = "live" | BackgroundSource;
type ExportOrigin = "live" | "cron" | "background";
const EXPORT_ORIGINS: readonly ExportOrigin[] = ["live", "cron", "background"];

interface SpendBucketTotals {
  costUsd: number;
  calls: number;
  tokens: number;
}

interface SpendTotals {
  costUsd: number;
  calls: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheHitRatio: number | null;
  live: SpendBucketTotals;
  background: SpendBucketTotals & { sources: Record<BackgroundSource, SpendBucketTotals> };
}

interface SpendEntity extends SpendTotals {
  principalId: string | null;
  scopeId: ScopeId;
  kind: string;
  displayName: string;
}

type SpendExportCron = Pick<Cron, "id" | "title" | "owner" | "ownerScopeId" | "schedule" | "enabled" | "archived">;
type SpendCronInfo = SpendExportCron & Pick<Cron, "action" | "message">;

interface SpendCron extends SpendTotals {
  cronId: string;
  scopeId: ScopeId;
  scopeName: string;
  info: SpendCronInfo | null;
}

interface SpendSeriesPoint {
  day: string;
  costUsd: number;
  calls: number;
  models: { model: string | null; costUsd: number }[];
  people: { principalId: string | null; costUsd: number }[];
  live: { costUsd: number };
  background: { costUsd: number; sources: Record<BackgroundSource, { costUsd: number }> };
}

export interface SpendReport {
  window: { from: string; to: string; bucket: SpendBucket };
  org: SpendTotals;
  series: SpendSeriesPoint[];
  people: SpendEntity[];
  scopes: SpendEntity[];
  crons: SpendCron[];
  models: ({ model: string | null } & SpendTotals)[];
}

export interface SpendExportRow extends Tally {
  day: string;
  scopeId: ScopeId;
  kind: string;
  principalId: string | null;
  displayName: string;
  origin: ExportOrigin;
  source: SpendSource;
  cronId: string | null;
  model: string | null;
}

export interface SpendSummaryOptions {
  from: number;
  to: number;
  bucket: SpendBucket;
  label: (scopeId: ScopeId) => string;
  cron: (cronId: string) => SpendCronInfo | null;
}

interface Tally {
  costUsd: number;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface EntityAccumulator {
  principalId: string | null;
  scopeId: ScopeId;
  kind: string;
  sources: ScopeId[];
  bySource: Record<SpendSource, Tally>;
}

function emptyTally(): Tally {
  return { costUsd: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function emptySources(): Record<SpendSource, Tally> {
  return {
    live: emptyTally(),
    cron: emptyTally(),
    loop: emptyTally(),
    swarm: emptyTally(),
    webhook: emptyTally(),
    monitor: emptyTally(),
  };
}

function backgroundSources<T>(value: (source: BackgroundSource) => T): Record<BackgroundSource, T> {
  return Object.fromEntries(BACKGROUND_SOURCES.map((source) => [source, value(source)])) as Record<BackgroundSource, T>;
}

function backgroundTally(bySource: Record<SpendSource, Tally>): Tally {
  const total = emptyTally();
  for (const source of BACKGROUND_SOURCES) addTally(total, bySource[source]);
  return total;
}

function addRow(t: Tally, r: SpendRow): void {
  t.costUsd += r.costUsd;
  t.calls += r.calls;
  t.input += r.input;
  t.output += r.output;
  t.cacheRead += r.cacheRead;
  t.cacheWrite += r.cacheWrite;
}

function addTally(t: Tally, other: Tally): void {
  t.costUsd += other.costUsd;
  t.calls += other.calls;
  t.input += other.input;
  t.output += other.output;
  t.cacheRead += other.cacheRead;
  t.cacheWrite += other.cacheWrite;
}

function tokensOf(t: Tally): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

function bucketTotals(t: Tally): SpendBucketTotals {
  return { costUsd: t.costUsd, calls: t.calls, tokens: tokensOf(t) };
}

function spendSource(origin: SessionOrigin): SpendSource {
  return origin === "conversation" ? "live" : origin;
}

function exportOrigin(source: SpendSource): ExportOrigin {
  return source === "live" || source === "cron" ? source : "background";
}

function isoDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function weekStart(day: number): number {
  return day - ((day + 3) % 7);
}

function totalsOf(bySource: Record<SpendSource, Tally>): SpendTotals {
  const background = backgroundTally(bySource);
  const total = emptyTally();
  addTally(total, bySource.live);
  addTally(total, background);
  return {
    costUsd: total.costUsd,
    calls: total.calls,
    tokens: tokensOf(total),
    input: total.input,
    output: total.output,
    cacheRead: total.cacheRead,
    cacheWrite: total.cacheWrite,
    cacheHitRatio: cacheHitRatio({
      cacheRead: total.cacheRead,
      cacheWrite: total.cacheWrite,
      uncachedInput: total.input,
    }),
    live: bucketTotals(bySource.live),
    background: {
      ...bucketTotals(background),
      sources: backgroundSources((source) => bucketTotals(bySource[source])),
    },
  };
}

function resolveScope(scopeId: ScopeId): { key: ScopeId; person: string | null; kind: string } {
  const parsed = parseScopeId(scopeId);
  const person = parsed.kind === "personal" && parsed.ref ? canonicalPerson(parsed.ref) : null;
  return {
    key: person === null ? scopeId : personalScope(person),
    person,
    kind: person === null ? (parsed.kind ?? "unknown") : "person",
  };
}

function displayNameOf(sources: readonly ScopeId[], label: (scopeId: ScopeId) => string): string {
  return sources.map(label).find((name) => name) ?? "";
}

function entityOf(acc: EntityAccumulator, label: (scopeId: ScopeId) => string): SpendEntity {
  return {
    principalId: acc.principalId,
    scopeId: acc.scopeId,
    kind: acc.kind,
    displayName: displayNameOf(acc.sources, label),
    ...totalsOf(acc.bySource),
  };
}

function byCodePoint(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function byCostThen<T extends { costUsd: number }>(id: (row: T) => string | null): (a: T, b: T) => number {
  return (a, b) => (a.costUsd !== b.costUsd ? b.costUsd - a.costUsd : byCodePoint(id(a), id(b)));
}

const byCostThenId = byCostThen<SpendEntity>((entity) => entity.scopeId);
const byCostThenModel = byCostThen<{ model: string | null; costUsd: number }>((row) => row.model);
const byCostThenCron = byCostThen<SpendCron>((row) => row.cronId);

export function summarizeSpend(rows: readonly SpendRow[], opts: SpendSummaryOptions): SpendReport {
  const accumulators = new Map<string, EntityAccumulator>();
  const buckets = new Map<
    number,
    { bySource: Record<SpendSource, Tally>; models: Map<string | null, number>; people: Map<string | null, number> }
  >();
  const modelBuckets = new Map<string | null, Record<SpendSource, Tally>>();
  const cronBuckets = new Map<string, { scopeId: ScopeId; bySource: Record<SpendSource, Tally> }>();
  const orgSources = emptySources();
  for (const row of rows) {
    const { key, person, kind } = resolveScope(row.scopeId);
    let acc = accumulators.get(key);
    if (!acc) {
      acc = { principalId: person, scopeId: key, kind, sources: [], bySource: emptySources() };
      accumulators.set(key, acc);
    }
    if (!acc.sources.includes(row.scopeId)) acc.sources.push(row.scopeId);
    const source = spendSource(row.origin);
    addRow(acc.bySource[source], row);
    addRow(orgSources[source], row);
    if (row.cronId !== null) {
      let cron = cronBuckets.get(row.cronId);
      if (!cron) {
        cron = { scopeId: row.scopeId, bySource: emptySources() };
        cronBuckets.set(row.cronId, cron);
      }
      addRow(cron.bySource[source], row);
    }
    let model = modelBuckets.get(row.model);
    if (!model) {
      model = emptySources();
      modelBuckets.set(row.model, model);
    }
    addRow(model[source], row);

    const bucketKey = opts.bucket === "week" ? weekStart(row.day) : row.day;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { bySource: emptySources(), models: new Map(), people: new Map() };
      buckets.set(bucketKey, bucket);
    }
    addRow(bucket.bySource[source], row);
    bucket.models.set(row.model, (bucket.models.get(row.model) ?? 0) + row.costUsd);
    bucket.people.set(person, (bucket.people.get(person) ?? 0) + row.costUsd);
  }

  const entities = [...accumulators.values()].map((acc) => entityOf(acc, opts.label));
  const people = entities.filter((e) => e.principalId !== null).sort(byCostThenId);
  const scopes = entities.filter((e) => e.principalId === null).sort(byCostThenId);

  const crons = [...cronBuckets.entries()]
    .map(([cronId, { scopeId, bySource }]) => ({
      cronId,
      scopeId,
      scopeName: opts.label(scopeId),
      info: opts.cron(cronId),
      ...totalsOf(bySource),
    }))
    .sort(byCostThenCron);

  const models = [...modelBuckets.entries()]
    .map(([model, bySource]) => ({ model, ...totalsOf(bySource) }))
    .sort(byCostThenModel);

  const series = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, { bySource, models, people }]) => {
      const background = backgroundTally(bySource);
      const total = emptyTally();
      addTally(total, bySource.live);
      addTally(total, background);
      return {
        day: isoDay(day),
        costUsd: total.costUsd,
        calls: total.calls,
        models: [...models].map(([model, costUsd]) => ({ model, costUsd })).sort(byCostThenModel),
        people: [...people]
          .sort(([a], [b]) => byCodePoint(a, b))
          .map(([principalId, costUsd]) => ({ principalId, costUsd })),
        live: { costUsd: bySource.live.costUsd },
        background: {
          costUsd: background.costUsd,
          sources: backgroundSources((source) => ({ costUsd: bySource[source].costUsd })),
        },
      };
    });

  return {
    window: {
      from: isoDay(Math.floor(opts.from / DAY_MS)),
      to: isoDay(Math.floor(opts.to / DAY_MS)),
      bucket: opts.bucket,
    },
    org: totalsOf(orgSources),
    series,
    people,
    scopes,
    crons,
    models,
  };
}

export function spendExportRows(rows: readonly SpendRow[], label: (scopeId: ScopeId) => string): SpendExportRow[] {
  const sources = new Map<ScopeId, ScopeId[]>();
  const merged = new Map<string, SpendExportRow>();
  for (const row of rows) {
    const { key: scopeId, person, kind } = resolveScope(row.scopeId);
    const seen = sources.get(scopeId);
    if (!seen) sources.set(scopeId, [row.scopeId]);
    else if (!seen.includes(row.scopeId)) seen.push(row.scopeId);
    const source = spendSource(row.origin);
    const key = JSON.stringify([row.day, scopeId, source, row.cronId, row.model]);
    let out = merged.get(key);
    if (!out) {
      out = {
        day: isoDay(row.day),
        scopeId,
        kind,
        principalId: person,
        displayName: "",
        origin: exportOrigin(source),
        source,
        cronId: row.cronId,
        model: row.model,
        ...emptyTally(),
      };
      merged.set(key, out);
    }
    addRow(out, row);
  }
  return [...merged.values()]
    .map((out) => ({ ...out, displayName: displayNameOf(sources.get(out.scopeId) ?? [], label) }))
    .sort(
      (a, b) =>
        byCodePoint(a.day, b.day) ||
        byCodePoint(a.scopeId, b.scopeId) ||
        EXPORT_ORIGINS.indexOf(a.origin) - EXPORT_ORIGINS.indexOf(b.origin) ||
        byCodePoint(a.source, b.source) ||
        byCodePoint(a.cronId ?? "", b.cronId ?? "") ||
        byCodePoint(a.model ?? "", b.model ?? ""),
    );
}

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const defanged = CSV_FORMULA_LEAD.test(value) ? `'${value}` : value;
  return CSV_NEEDS_QUOTES.test(defanged) ? `"${defanged.replaceAll('"', '""')}"` : defanged;
}

function csvBreakdown(
  report: SpendReport,
  breakdown: SpendBreakdown,
): { header: string[]; rows: { labels: (string | null)[]; totals: SpendTotals }[] } {
  if (breakdown === "model")
    return {
      header: ["model"],
      rows: report.models.map((row) => ({ labels: [row.model ?? "Unknown model"], totals: row })),
    };
  if (breakdown === "cron")
    return {
      header: ["cron_id", "title", "owner", "scope_id"],
      rows: report.crons.map((row) => ({
        labels: [row.cronId, row.info?.title ?? null, row.info?.owner ?? null, row.scopeId],
        totals: row,
      })),
    };
  return {
    header: ["principal_id", "scope_id", "kind", "display_name"],
    rows: [...report.people, ...report.scopes].map((row) => ({
      labels: [row.principalId, row.scopeId, row.kind, row.displayName],
      totals: row,
    })),
  };
}

export function spendCsv(report: SpendReport, breakdown: SpendBreakdown = "entity"): string {
  const { header, rows } = csvBreakdown(report, breakdown);
  const lines = [[...header, ...CSV_TOTALS_HEADER].join(",")];
  for (const { labels, totals: row } of rows) {
    lines.push(
      [
        ...labels,
        row.live.costUsd,
        row.background.costUsd,
        ...BACKGROUND_SOURCES.map((source) => row.background.sources[source].costUsd),
        row.costUsd,
        row.calls,
        row.input,
        row.output,
        row.cacheRead,
        row.cacheWrite,
        row.cacheHitRatio,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

function parseDay(raw: string): number | null {
  const value = raw.trim();
  if (!DATE_ONLY.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed : null;
}

function parseBound(raw: string): number | null {
  const day = parseDay(raw);
  if (day !== null || !EPOCH_MS.test(raw.trim())) return day;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && Number.isFinite(new Date(parsed).getTime()) ? parsed : null;
}

async function loadSpendRows(
  sessions: SessionStore,
  range: { from: number; to: number },
): Promise<{ rows: SpendRow[]; asOf?: number }> {
  return sessions.spendReport ? sessions.spendReport(range) : { rows: await sessions.spendRollup(range) };
}

async function cronInfoLookup(
  app: BaseCtx["app"],
  rows: readonly { cronId: string | null }[],
): Promise<(cronId: string) => SpendCronInfo | null> {
  const ids = [...new Set(rows.flatMap((row) => (row.cronId === null ? [] : [row.cronId])))];
  const crons = new Map<string, SpendCronInfo>();
  for (let start = 0; start < ids.length; start += CRON_LOOKUP_CONCURRENCY) {
    const batch = await Promise.all(ids.slice(start, start + CRON_LOOKUP_CONCURRENCY).map((id) => app.getCron(id)));
    for (const cron of batch) {
      if (!cron) continue;
      const { id, title, message, action, owner, ownerScopeId, schedule, enabled, archived } = cron;
      crons.set(id, { id, title, message, action, owner, ownerScopeId, schedule, enabled, archived });
    }
  }
  return (cronId) => crons.get(cronId) ?? null;
}

export async function spendExport(ctx: BaseCtx): Promise<void> {
  const { req, res, app, deps, url } = ctx;
  const token = deps.spendExportToken;
  if (!token) return sendJson(res, 404, { error: "not_found" });
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string" || !constantTimeEqual(authorization, `Bearer ${token}`))
    return sendJson(res, 401, { error: "unauthorized" });
  if (!deps.sessions) return sendJson(res, 503, { error: "spend_unavailable" });
  const from = parseDay(url.searchParams.get("from") ?? "");
  const to = parseDay(url.searchParams.get("to") ?? "");
  if (from === null || to === null)
    return sendJson(res, 400, { error: "bad_request", message: "from and to must be YYYY-MM-DD dates (UTC)" });
  if (to <= from || to - from > EXPORT_MAX_DAYS * DAY_MS)
    return sendJson(res, 400, {
      error: "bad_request",
      message: `to must be later than from and at most ${EXPORT_MAX_DAYS} days after it`,
    });
  const { rows, asOf } = await loadSpendRows(deps.sessions, { from, to });
  const labels = await discoverScopes(
    app,
    deps,
    rows.map((r) => r.scopeId),
  );
  const scope = orgScope(deps);
  const window = { from: isoDay(from / DAY_MS), to: isoDay(to / DAY_MS) };
  const exported = spendExportRows(rows, (id) => labels.get(id) ?? "");
  const cronInfo = await cronInfoLookup(app, exported);
  const crons: SpendExportCron[] = [...new Set(exported.flatMap((row) => (row.cronId === null ? [] : [row.cronId])))]
    .sort(byCodePoint)
    .flatMap((cronId) => {
      const info = cronInfo(cronId);
      if (!info) return [];
      const { id, title, owner, ownerScopeId, schedule, enabled, archived } = info;
      return [{ id, title, owner, ownerScopeId, schedule, enabled, archived }];
    });
  audit(deps, {
    principalId: SPEND_EXPORT_PRINCIPAL,
    action: "spend.export",
    resource: "spend",
    scopeLabel: scope,
    detail: `${window.from}..${window.to} rows=${exported.length}`,
  });
  sendJson(res, 200, { scopeId: scope, window, ...(asOf === undefined ? {} : { asOf }), rows: exported, crons });
}

export async function spend(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, url } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  audit(deps, { principalId: actor.id, action: "spend.read", resource: "spend", scopeLabel: scope });

  const bad = (message: string) => sendJson(res, 400, { error: "bad_request", message });
  const bucket = url.searchParams.get("bucket") ?? "day";
  if (bucket !== "day" && bucket !== "week") return bad('bucket must be "day" or "week"');
  const format = url.searchParams.get("format") ?? "json";
  if (format !== "json" && format !== "csv") return bad('format must be "json" or "csv"');

  const breakdown = SPEND_BREAKDOWNS.find((value) => value === (url.searchParams.get("breakdown") ?? "entity"));
  if (!breakdown) return bad('breakdown must be "entity", "model" or "cron"');

  const toRaw = url.searchParams.get("to");
  const to = toRaw === null ? Math.floor(Date.now() / DAY_MS) * DAY_MS + DAY_MS : parseBound(toRaw);
  if (to === null) return bad("to must be a YYYY-MM-DD date (UTC) or epoch milliseconds");
  const fromRaw = url.searchParams.get("from");
  const from = fromRaw === null ? to - DEFAULT_WINDOW_DAYS * DAY_MS : parseBound(fromRaw);
  if (from === null) return bad("from must be a YYYY-MM-DD date (UTC) or epoch milliseconds");
  if (to <= from) return bad("to must be later than from");

  const { rows, asOf } = deps.sessions
    ? await loadSpendRows(deps.sessions, { from, to })
    : { rows: [], asOf: undefined };
  const labels = await discoverScopes(
    app,
    deps,
    rows.map((r) => r.scopeId),
  );
  const report = summarizeSpend(rows, {
    from,
    to,
    bucket,
    label: (id) => labels.get(id) ?? "",
    cron: format === "csv" && breakdown !== "cron" ? () => null : await cronInfoLookup(app, rows),
  });
  if (format === "json")
    return sendJson(res, 200, { scopeId: scope, ...report, ...(asOf === undefined ? {} : { asOf }) });

  const body = spendCsv(report, breakdown);
  res.writeHead(200, {
    "content-type": contentTypeWithUtf8Charset("text/csv"),
    "content-length": String(Buffer.byteLength(body)),
    "content-disposition": contentDispositionAttachment(
      `qm-spend-${breakdown === "entity" ? "" : `${breakdown}s-`}${report.window.from}-${report.window.to}.csv`,
    ),
    "x-content-type-options": "nosniff",
  });
  res.end(body);
  return;
}
