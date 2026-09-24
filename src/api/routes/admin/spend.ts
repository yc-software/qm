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
const CSV_HEADER = [
  "principal_id",
  "scope_id",
  "kind",
  "display_name",
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

function entityOf(acc: EntityAccumulator, label: (scopeId: ScopeId) => string): SpendEntity {
  const total = emptyTally();
  for (const bucket of ORIGIN_BUCKETS) addTally(total, acc.byOrigin[bucket]);
  return {
    principalId: acc.principalId,
    scopeId: acc.scopeId,
    kind: acc.kind,
    displayName: acc.sources.map(label).find((name) => name) ?? "",
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
    live: bucketTotals(acc.byOrigin.live),
    cron: bucketTotals(acc.byOrigin.cron),
    background: bucketTotals(acc.byOrigin.background),
  };
}

function byCostThenId(a: SpendEntity, b: SpendEntity): number {
  if (a.costUsd !== b.costUsd) return b.costUsd - a.costUsd;
  if (a.scopeId === b.scopeId) return 0;
  return a.scopeId < b.scopeId ? -1 : 1;
}

export function summarizeSpend(rows: readonly SpendRow[], opts: SpendSummaryOptions): SpendReport {
  const accumulators = new Map<string, EntityAccumulator>();
  const buckets = new Map<number, Record<OriginBucket, Tally>>();
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
    addRow(acc.byOrigin[originBucket(row.origin)], row);

    const bucketKey = opts.bucket === "week" ? weekStart(row.day) : row.day;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = emptyOrigins();
      buckets.set(bucketKey, bucket);
    }
    addRow(bucket[originBucket(row.origin)], row);
  }

  const entities = [...accumulators.values()].map((acc) => entityOf(acc, opts.label));
  const people = entities.filter((e) => e.principalId !== null).sort(byCostThenId);
  const scopes = entities.filter((e) => e.principalId === null).sort(byCostThenId);

  const orgTotal = emptyTally();
  const orgBuckets: Record<OriginBucket, SpendBucketTotals> = {
    live: { costUsd: 0, calls: 0, tokens: 0 },
    cron: { costUsd: 0, calls: 0, tokens: 0 },
    background: { costUsd: 0, calls: 0, tokens: 0 },
  };
  let orgTokens = 0;
  for (const entity of [...people, ...scopes]) {
    orgTotal.costUsd += entity.costUsd;
    orgTotal.calls += entity.calls;
    orgTotal.input += entity.input;
    orgTotal.output += entity.output;
    orgTotal.cacheRead += entity.cacheRead;
    orgTotal.cacheWrite += entity.cacheWrite;
    orgTokens += entity.tokens;
    for (const bucket of ORIGIN_BUCKETS) {
      orgBuckets[bucket].costUsd += entity[bucket].costUsd;
      orgBuckets[bucket].calls += entity[bucket].calls;
      orgBuckets[bucket].tokens += entity[bucket].tokens;
    }
  }

  const series = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, byOrigin]) => {
      const total = emptyTally();
      for (const bucket of ORIGIN_BUCKETS) addTally(total, byOrigin[bucket]);
      return {
        day: isoDay(day),
        costUsd: total.costUsd,
        calls: total.calls,
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
    org: {
      costUsd: orgTotal.costUsd,
      calls: orgTotal.calls,
      tokens: orgTokens,
      input: orgTotal.input,
      output: orgTotal.output,
      cacheRead: orgTotal.cacheRead,
      cacheWrite: orgTotal.cacheWrite,
      cacheHitRatio: cacheHitRatio({
        cacheRead: orgTotal.cacheRead,
        cacheWrite: orgTotal.cacheWrite,
        uncachedInput: orgTotal.input,
      }),
      live: orgBuckets.live,
      cron: orgBuckets.cron,
      background: orgBuckets.background,
    },
    series,
    people,
    scopes,
  };
}

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const defanged = CSV_FORMULA_LEAD.test(value) ? `'${value}` : value;
  return CSV_NEEDS_QUOTES.test(defanged) ? `"${defanged.replaceAll('"', '""')}"` : defanged;
}

export function spendCsv(report: SpendReport): string {
  const lines = [CSV_HEADER.join(",")];
  for (const row of [...report.people, ...report.scopes]) {
    lines.push(
      [
        csvCell(row.principalId),
        csvCell(row.scopeId),
        csvCell(row.kind),
        csvCell(row.displayName),
        csvCell(row.live.costUsd),
        csvCell(row.cron.costUsd),
        csvCell(row.background.costUsd),
        csvCell(row.costUsd),
        csvCell(row.calls),
        csvCell(row.input),
        csvCell(row.output),
        csvCell(row.cacheRead),
        csvCell(row.cacheWrite),
        csvCell(row.cacheHitRatio),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

function parseBound(raw: string): number | null {
  const value = raw.trim();
  let parsed = NaN;
  if (DATE_ONLY.test(value)) parsed = Date.parse(`${value}T00:00:00.000Z`);
  else if (EPOCH_MS.test(value)) parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
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

  const toRaw = url.searchParams.get("to");
  const to = toRaw === null ? Math.floor(Date.now() / DAY_MS) * DAY_MS + DAY_MS : parseBound(toRaw);
  if (to === null) return bad("to must be a YYYY-MM-DD date (UTC) or epoch milliseconds");
  const fromRaw = url.searchParams.get("from");
  const from = fromRaw === null ? to - DEFAULT_WINDOW_DAYS * DAY_MS : parseBound(fromRaw);
  if (from === null) return bad("from must be a YYYY-MM-DD date (UTC) or epoch milliseconds");
  if (to <= from) return bad("to must be later than from");

  const rows = (await deps.sessions?.spendRollup({ from, to })) ?? [];
  const labels = await discoverScopes(
    app,
    deps,
    rows.map((r) => r.scopeId),
  );
  const report = summarizeSpend(rows, { from, to, bucket, label: (id) => labels.get(id) ?? "" });
  if (format === "json") return sendJson(res, 200, { scopeId: scope, ...report });

  const body = spendCsv(report);
  res.writeHead(200, {
    "content-type": contentTypeWithUtf8Charset("text/csv"),
    "content-length": String(Buffer.byteLength(body)),
    "content-disposition": contentDispositionAttachment(`qm-spend-${report.window.from}-${report.window.to}.csv`),
    "x-content-type-options": "nosniff",
  });
  res.end(body);
  return;
}
