import { cacheHitRatio } from "../../../admin/metrics-sink.ts";
import { canonicalPerson } from "../../../directory/person.ts";
import { parseScopeId, personalScope, type ScopeId } from "../../../types.ts";
import type { SessionOrigin, SpendRow } from "../../../sessions/session-store.ts";
import { contentDispositionAttachment, contentTypeWithUtf8Charset, sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import { discoverScopes } from "./common.ts";
import { type ApiCtx } from "../route.ts";

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 30;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const EPOCH_MS = /^\d+$/;
const CSV_FORMULA_LEAD = /^[=+\-@\t\r]/;
const CSV_NEEDS_QUOTES = /["\r\n,]/;
const CSV_TOTALS_HEADER = [
  "live_usd",
  "cron_usd",
  "background_usd",
  "total_usd",
  "calls",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cache_hit_ratio",
];

type SpendBreakdown = "entity" | "model";
type SpendBucket = "day" | "week";
type OriginBucket = "live" | "cron" | "background";
const ORIGIN_BUCKETS: readonly OriginBucket[] = ["live", "cron", "background"];

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
  cron: SpendBucketTotals;
  background: SpendBucketTotals;
}

interface SpendEntity extends SpendTotals {
  principalId: string | null;
  scopeId: ScopeId;
  kind: string;
  displayName: string;
}

interface SpendSeriesPoint {
  day: string;
  costUsd: number;
  calls: number;
  models: { model: string | null; costUsd: number }[];
  people: { principalId: string | null; costUsd: number }[];
  live: { costUsd: number };
  cron: { costUsd: number };
  background: { costUsd: number };
}

export interface SpendReport {
  window: { from: string; to: string; bucket: SpendBucket };
  org: SpendTotals;
  series: SpendSeriesPoint[];
  people: SpendEntity[];
  scopes: SpendEntity[];
  models: ({ model: string | null } & SpendTotals)[];
}

export interface SpendSummaryOptions {
  from: number;
  to: number;
  bucket: SpendBucket;
  label: (scopeId: ScopeId) => string;
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
  byOrigin: Record<OriginBucket, Tally>;
}

function emptyTally(): Tally {
  return { costUsd: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function emptyOrigins(): Record<OriginBucket, Tally> {
  return { live: emptyTally(), cron: emptyTally(), background: emptyTally() };
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

function originBucket(origin: SessionOrigin): OriginBucket {
  if (origin === "conversation") return "live";
  if (origin === "cron") return "cron";
  return "background";
}

function isoDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function weekStart(day: number): number {
  return day - ((day + 3) % 7);
}

function totalsOf(byOrigin: Record<OriginBucket, Tally>): SpendTotals {
  const total = emptyTally();
  for (const bucket of ORIGIN_BUCKETS) addTally(total, byOrigin[bucket]);
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
    live: bucketTotals(byOrigin.live),
    cron: bucketTotals(byOrigin.cron),
    background: bucketTotals(byOrigin.background),
  };
}

function entityOf(acc: EntityAccumulator, label: (scopeId: ScopeId) => string): SpendEntity {
  return {
    principalId: acc.principalId,
    scopeId: acc.scopeId,
    kind: acc.kind,
    displayName: acc.sources.map(label).find((name) => name) ?? "",
    ...totalsOf(acc.byOrigin),
  };
}

function byCostThenId(a: SpendEntity, b: SpendEntity): number {
  if (a.costUsd !== b.costUsd) return b.costUsd - a.costUsd;
  if (a.scopeId === b.scopeId) return 0;
  return a.scopeId < b.scopeId ? -1 : 1;
}

function byCostThenModel(
  a: { model: string | null; costUsd: number },
  b: { model: string | null; costUsd: number },
): number {
  if (a.costUsd !== b.costUsd) return b.costUsd - a.costUsd;
  if (a.model === b.model) return 0;
  if (a.model === null) return 1;
  if (b.model === null) return -1;
  return a.model < b.model ? -1 : 1;
}

export function summarizeSpend(rows: readonly SpendRow[], opts: SpendSummaryOptions): SpendReport {
  const accumulators = new Map<string, EntityAccumulator>();
  const buckets = new Map<
    number,
    { byOrigin: Record<OriginBucket, Tally>; models: Map<string | null, number>; people: Map<string | null, number> }
  >();
  const modelBuckets = new Map<string | null, Record<OriginBucket, Tally>>();
  const orgOrigins = emptyOrigins();
  for (const row of rows) {
    const parsed = parseScopeId(row.scopeId);
    const person = parsed.kind === "personal" && parsed.ref ? canonicalPerson(parsed.ref) : null;
    const key = person === null ? row.scopeId : personalScope(person);
    let acc = accumulators.get(key);
    if (!acc) {
      acc = {
        principalId: person,
        scopeId: key,
        kind: person === null ? (parsed.kind ?? "unknown") : "person",
        sources: [],
        byOrigin: emptyOrigins(),
      };
      accumulators.set(key, acc);
    }
    if (!acc.sources.includes(row.scopeId)) acc.sources.push(row.scopeId);
    const origin = originBucket(row.origin);
    addRow(acc.byOrigin[origin], row);
    addRow(orgOrigins[origin], row);
    let model = modelBuckets.get(row.model);
    if (!model) {
      model = emptyOrigins();
      modelBuckets.set(row.model, model);
    }
    addRow(model[origin], row);

    const bucketKey = opts.bucket === "week" ? weekStart(row.day) : row.day;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { byOrigin: emptyOrigins(), models: new Map(), people: new Map() };
      buckets.set(bucketKey, bucket);
    }
    addRow(bucket.byOrigin[origin], row);
    bucket.models.set(row.model, (bucket.models.get(row.model) ?? 0) + row.costUsd);
    bucket.people.set(person, (bucket.people.get(person) ?? 0) + row.costUsd);
  }

  const entities = [...accumulators.values()].map((acc) => entityOf(acc, opts.label));
  const people = entities.filter((e) => e.principalId !== null).sort(byCostThenId);
  const scopes = entities.filter((e) => e.principalId === null).sort(byCostThenId);

  const models = [...modelBuckets.entries()]
    .map(([model, byOrigin]) => ({ model, ...totalsOf(byOrigin) }))
    .sort(byCostThenModel);

  const series = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, { byOrigin, models, people }]) => {
      const total = emptyTally();
      for (const bucket of ORIGIN_BUCKETS) addTally(total, byOrigin[bucket]);
      return {
        day: isoDay(day),
        costUsd: total.costUsd,
        calls: total.calls,
        models: [...models].map(([model, costUsd]) => ({ model, costUsd })).sort(byCostThenModel),
        people: [...people]
          .sort(([a], [b]) => {
            if (a === b) return 0;
            if (a === null) return 1;
            if (b === null) return -1;
            return a < b ? -1 : 1;
          })
          .map(([principalId, costUsd]) => ({ principalId, costUsd })),
        live: { costUsd: byOrigin.live.costUsd },
        cron: { costUsd: byOrigin.cron.costUsd },
        background: { costUsd: byOrigin.background.costUsd },
      };
    });

  return {
    window: {
      from: isoDay(Math.floor(opts.from / DAY_MS)),
      to: isoDay(Math.floor(opts.to / DAY_MS)),
      bucket: opts.bucket,
    },
    org: totalsOf(orgOrigins),
    series,
    people,
    scopes,
    models,
  };
}

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const defanged = CSV_FORMULA_LEAD.test(value) ? `'${value}` : value;
  return CSV_NEEDS_QUOTES.test(defanged) ? `"${defanged.replaceAll('"', '""')}"` : defanged;
}

export function spendCsv(report: SpendReport, breakdown: SpendBreakdown = "entity"): string {
  const modelBreakdown = breakdown === "model";
  const header = modelBreakdown ? ["model"] : ["principal_id", "scope_id", "kind", "display_name"];
  const rows = modelBreakdown
    ? report.models.map((row) => ({ labels: [row.model ?? "Unknown model"], totals: row }))
    : [...report.people, ...report.scopes].map((row) => ({
        labels: [row.principalId, row.scopeId, row.kind, row.displayName],
        totals: row,
      }));
  const lines = [[...header, ...CSV_TOTALS_HEADER].join(",")];
  for (const { labels, totals: row } of rows) {
    lines.push(
      [
        ...labels,
        row.live.costUsd,
        row.cron.costUsd,
        row.background.costUsd,
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

function parseBound(raw: string): number | null {
  const value = raw.trim();
  let parsed = NaN;
  if (DATE_ONLY.test(value)) {
    parsed = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) return null;
  } else if (EPOCH_MS.test(value)) parsed = Number(value);
  return Number.isSafeInteger(parsed) && Number.isFinite(new Date(parsed).getTime()) ? parsed : null;
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

  const breakdown = url.searchParams.get("breakdown") ?? "entity";
  if (breakdown !== "entity" && breakdown !== "model") return bad('breakdown must be "entity" or "model"');

  const toRaw = url.searchParams.get("to");
  const to = toRaw === null ? Math.floor(Date.now() / DAY_MS) * DAY_MS + DAY_MS : parseBound(toRaw);
  if (to === null) return bad("to must be a YYYY-MM-DD date (UTC) or epoch milliseconds");
  const fromRaw = url.searchParams.get("from");
  const from = fromRaw === null ? to - DEFAULT_WINDOW_DAYS * DAY_MS : parseBound(fromRaw);
  if (from === null) return bad("from must be a YYYY-MM-DD date (UTC) or epoch milliseconds");
  if (to <= from) return bad("to must be later than from");

  const { rows, asOf } = deps.sessions?.spendReport
    ? await deps.sessions.spendReport({ from, to })
    : { rows: (await deps.sessions?.spendRollup({ from, to })) ?? [], asOf: undefined };
  const labels = await discoverScopes(
    app,
    deps,
    rows.map((r) => r.scopeId),
  );
  const report = summarizeSpend(rows, { from, to, bucket, label: (id) => labels.get(id) ?? "" });
  if (format === "json")
    return sendJson(res, 200, { scopeId: scope, ...report, ...(asOf === undefined ? {} : { asOf }) });

  const body = spendCsv(report, breakdown);
  res.writeHead(200, {
    "content-type": contentTypeWithUtf8Charset("text/csv"),
    "content-length": String(Buffer.byteLength(body)),
    "content-disposition": contentDispositionAttachment(
      `qm-spend-${breakdown === "model" ? "models-" : ""}${report.window.from}-${report.window.to}.csv`,
    ),
    "x-content-type-options": "nosniff",
  });
  res.end(body);
  return;
}
