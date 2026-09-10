import {
  createTranscriptSource,
  projectTapeEntries,
  renderableTapeSlice,
  RENDER_IMPORT_EVENT,
} from "../../src/harness/tape-projection.ts";
import { appendCoverageImport, coverageImportViable } from "../../src/harness/replay.ts";
import { lastImportLacksScopes } from "../../src/harness/tape-fold.ts";
import {
  TAPE_IMPORT_MAX_ENTRIES,
  tapeCheckpointPayload,
  tapeEntryMirrorRecord,
  type GetEntriesOptions,
  type Lease,
  type SessionStore,
  type TapeRecord,
} from "../../src/sessions/session-store.ts";
import type { ScopeId, SessionEntry } from "../../src/types.ts";
import { canonicalJson, isObj } from "../../src/util/objects.ts";

export const RENDER_IMPORT_MAX_ENTRIES = TAPE_IMPORT_MAX_ENTRIES;

export function assertProjectionUnderstandsRenderImports(): void {
  const scopeLabel = "assert" as ScopeId;
  const entry: SessionEntry = {
    sessionId: "assert",
    seq: 0,
    parentSeq: null,
    type: "user",
    payload: { text: "x" },
    scopeLabel,
    createdAt: 1,
  };
  const rows: TapeRecord[] = [
    {
      sessionId: "assert",
      seq: 0,
      createdAt: 1,
      kind: "context_event",
      payload: { event: "legacy_import", messages: [], scopes: [] },
      scopeLabel,
    },
    { ...tapeEntryMirrorRecord(entry), sessionId: "assert", seq: 1, createdAt: 1 },
    {
      sessionId: "assert",
      seq: 2,
      createdAt: 1,
      kind: "annotation",
      payload: tapeCheckpointPayload("turnEnd", undefined, 0),
      scopeLabel,
      entrySeq: 0,
    },
    {
      sessionId: "assert",
      seq: 3,
      createdAt: 1,
      kind: "context_event",
      payload: { event: RENDER_IMPORT_EVENT, firstTapeSeq: 1 },
      scopeLabel,
      coversEntrySeq: 0,
    },
  ];
  const projection = projectTapeEntries("assert", rows);
  if (!projection || projection.coveredSeq !== 0 || projection.entries.length !== 1) {
    throw new Error("this checkout's tape projection does not understand render_import anchors; refusing to backfill");
  }
}

type RenderImportSkip = "empty" | "covered" | "oversize" | "gapped" | "unservable-fold";

export type RenderImportAssessment =
  | { action: "skip"; reason: RenderImportSkip }
  | { action: "import"; entries: SessionEntry[]; latestSeq: number; needsFoldImport: boolean };

export async function assessRenderImport(
  store: Pick<SessionStore, "latestEntrySeq" | "tapeCoverage" | "getTape" | "getEntries">,
  sessionId: string,
  opts?: { force?: boolean },
): Promise<RenderImportAssessment> {
  const latest = await store.latestEntrySeq(sessionId);
  if (latest < 0) return { action: "skip", reason: "empty" };
  const coverage = await store.tapeCoverage(sessionId);
  const rows = await store.getTape(sessionId);
  if (!opts?.force && coverage >= latest) {
    const projection = projectTapeEntries(sessionId, rows);
    if (projection && projection.coveredSeq >= latest) return { action: "skip", reason: "covered" };
  }
  const entries = await store.getEntries(sessionId);
  if (entries.length > RENDER_IMPORT_MAX_ENTRIES) return { action: "skip", reason: "oversize" };
  if (entries.some((e, i) => e.seq !== i)) return { action: "skip", reason: "gapped" };
  const needsFoldImport = coverage < latest || lastImportLacksScopes(rows);
  if (needsFoldImport && !coverageImportViable(entries)) return { action: "skip", reason: "unservable-fold" };
  return { action: "import", entries, latestSeq: latest, needsFoldImport };
}

export async function appendRenderImport(
  store: Pick<SessionStore, "appendTape">,
  lease: Lease,
  entries: readonly SessionEntry[],
  scopeLabel: ScopeId,
  needsFoldImport: boolean,
): Promise<"imported" | "unservable-fold"> {
  const last = entries[entries.length - 1];
  if (!last) return "unservable-fold";
  if (needsFoldImport && !(await appendCoverageImport(store, lease, entries, scopeLabel))) {
    return "unservable-fold";
  }
  let firstMirror: TapeRecord | undefined;
  for (const entry of entries) {
    const mirror = await store.appendTape(lease, tapeEntryMirrorRecord(entry));
    firstMirror ??= mirror;
  }
  await store.appendTape(lease, {
    kind: "annotation",
    payload: tapeCheckpointPayload("turnEnd", undefined, 0),
    scopeLabel,
    entrySeq: last.seq,
  });
  await store.appendTape(lease, {
    kind: "context_event",
    payload: { event: RENDER_IMPORT_EVENT, firstTapeSeq: firstMirror!.seq },
    scopeLabel,
    coversEntrySeq: last.seq,
  });
  return "imported";
}

export type DivergenceClass =
  "tool-payload" | "intra-turn-order" | "timestamp" | "overheard-mentions" | "coarse-gap" | "taint-cleared";

export const DIVERGENCE_CLASSES: readonly DivergenceClass[] = [
  "tool-payload",
  "intra-turn-order",
  "timestamp",
  "overheard-mentions",
  "coarse-gap",
  "taint-cleared",
];

export function emptyBenignCounts(): Record<DivergenceClass, number> {
  return {
    "tool-payload": 0,
    "intra-turn-order": 0,
    timestamp: 0,
    "overheard-mentions": 0,
    "coarse-gap": 0,
    "taint-cleared": 0,
  };
}

export interface RealDivergence {
  seq: number;
  field: string;
  entry: unknown;
  projected: unknown;
}

export interface ParityReport {
  benign: Record<DivergenceClass, number>;
  real: RealDivergence[];
}

function toolIdentity(entry: SessionEntry): string | null {
  if (entry.type !== "tool_call" && entry.type !== "tool_result") return null;
  const p = entry.payload as { tool?: unknown; callId?: unknown } | null;
  if (typeof p?.tool !== "string" || typeof p?.callId !== "string") return null;
  return `${entry.type}:${p.tool}:${p.callId}`;
}

function toolPayloadCompatible(entryPayload: unknown, projectedPayload: unknown): boolean {
  if (!isObj(entryPayload) || !isObj(projectedPayload)) {
    return canonicalJson(entryPayload) === canonicalJson(projectedPayload);
  }
  return Object.keys(projectedPayload).every(
    (k) =>
      !(k in entryPayload) ||
      canonicalJson(entryPayload[k]) === canonicalJson(projectedPayload[k]) ||
      (k === "isError" && entryPayload.isError === true && projectedPayload.isError === false),
  );
}

function withoutKey(payload: unknown, key: string): unknown {
  if (!isObj(payload)) return payload;
  const { [key]: _dropped, ...rest } = payload;
  return rest;
}

function taintCleared(entry: SessionEntry, projected: SessionEntry): boolean {
  return (
    isObj(projected.payload) &&
    projected.payload.securityTainted === true &&
    canonicalJson(entry.payload) === canonicalJson(withoutKey(projected.payload, "securityTainted"))
  );
}

function matchKey(entry: SessionEntry): string {
  return toolIdentity(entry) ?? `${entry.type}:${entry.scopeLabel}:${canonicalJson(entry.payload)}`;
}

export function classifyDivergences(
  entries: readonly SessionEntry[],
  projected: readonly SessionEntry[],
  opts: { coarse: boolean },
): ParityReport {
  const benign = emptyBenignCounts();
  const real: RealDivergence[] = [];
  const projectedBySeq = new Map(projected.map((e) => [e.seq, e]));
  const entryBySeq = new Map(entries.map((e) => [e.seq, e]));

  for (const p of projected) {
    if (!entryBySeq.has(p.seq)) real.push({ seq: p.seq, field: "extra-row", entry: undefined, projected: p });
  }

  const orderCandidates: Array<{ entry: SessionEntry; projected: SessionEntry }> = [];
  let segment = -1;
  const segmentOf = new Map<number, number>();
  for (const e of entries) {
    if (e.type === "user") segment = e.seq;
    segmentOf.set(e.seq, segment);
    const p = projectedBySeq.get(e.seq);
    if (!p) {
      if (opts.coarse) benign["coarse-gap"]++;
      else real.push({ seq: e.seq, field: "missing-row", entry: e, projected: undefined });
      continue;
    }
    if (e.parentSeq !== p.parentSeq) {
      real.push({ seq: e.seq, field: "parentSeq", entry: e.parentSeq, projected: p.parentSeq });
      continue;
    }
    if (e.type === p.type && e.scopeLabel === p.scopeLabel) {
      if (canonicalJson(e.payload) === canonicalJson(p.payload)) {
        if (e.createdAt !== p.createdAt) benign.timestamp++;
        continue;
      }
      if (
        e.type === "assistant" &&
        (p.payload as { workStartedAt?: unknown } | null)?.workStartedAt === undefined &&
        (p.payload as { workFinishedAt?: unknown } | null)?.workFinishedAt === undefined &&
        canonicalJson(withoutKey(withoutKey(e.payload, "workStartedAt"), "workFinishedAt")) === canonicalJson(p.payload)
      ) {
        benign.timestamp++;
        continue;
      }
      if (taintCleared(e, p)) {
        benign["taint-cleared"]++;
        continue;
      }
      if (toolIdentity(e) !== null && toolIdentity(e) === toolIdentity(p)) {
        if (toolPayloadCompatible(e.payload, p.payload)) {
          benign["tool-payload"]++;
        } else {
          real.push({ seq: e.seq, field: "tool-payload-content", entry: e, projected: p });
        }
        continue;
      }
      if (e.type === "user" && canonicalJson(withoutKey(e.payload, "mentions")) === canonicalJson(p.payload)) {
        benign["overheard-mentions"]++;
        continue;
      }
    }
    orderCandidates.push({ entry: e, projected: p });
  }

  const groups = new Map<number, Array<{ entry: SessionEntry; projected: SessionEntry }>>();
  for (const c of orderCandidates) {
    const key = segmentOf.get(c.entry.seq) ?? -1;
    const group = groups.get(key) ?? [];
    group.push(c);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const unmatchedProjected = group.map((c) => c.projected);
    for (const { entry } of group) {
      const key = matchKey(entry);
      const at = unmatchedProjected.findIndex((p) => matchKey(p) === key);
      if (at >= 0) {
        const [pair] = unmatchedProjected.splice(at, 1);
        if (toolIdentity(entry) === null || toolPayloadCompatible(entry.payload, pair!.payload)) {
          benign["intra-turn-order"]++;
          continue;
        }
      }
      real.push({ seq: entry.seq, field: "row", entry, projected: projectedBySeq.get(entry.seq) });
    }
  }

  return { benign, real };
}

export function coarseTape(rows: readonly TapeRecord[]): boolean {
  return renderableTapeSlice(rows).some((r) => r.kind === "message" && r.harness !== undefined && r.harness !== "pi");
}

export type SessionParity =
  { status: "unservable"; reason: "blocked" | "uncovered" } | { status: "compared"; report: ParityReport };

export function sessionParity(
  sessionId: string,
  entries: readonly SessionEntry[],
  rows: readonly TapeRecord[],
): SessionParity {
  const latest = entries.length ? entries[entries.length - 1]!.seq : -1;
  const projection = projectTapeEntries(sessionId, rows);
  if (!projection) return { status: "unservable", reason: "blocked" };
  if (projection.coveredSeq < latest) return { status: "unservable", reason: "uncovered" };
  return { status: "compared", report: classifyDivergences(entries, projection.entries, { coarse: coarseTape(rows) }) };
}

type TranscriptReadStore = Pick<
  SessionStore,
  "getEntries" | "visibleEntries" | "getTape" | "latestEntrySeq" | "participantWindowsOf"
>;

export type LimitedParity = { status: "fallback" } | { status: "projected"; report: ParityReport };

export async function limitedSessionParity(
  store: TranscriptReadStore,
  sessionId: string,
  entries: readonly SessionEntry[],
  rows: readonly TapeRecord[],
  limit: number,
): Promise<LimitedParity> {
  let fellBack = false;
  const recording: TranscriptReadStore = {
    getEntries: (id: string, opts?: GetEntriesOptions) => {
      fellBack = true;
      return store.getEntries(id, opts);
    },
    visibleEntries: (id: string, principalId: string) => {
      fellBack = true;
      return store.visibleEntries(id, principalId);
    },
    getTape: (id, opts) => store.getTape(id, opts),
    latestEntrySeq: (id) => store.latestEntrySeq(id),
    participantWindowsOf: (id) => store.participantWindowsOf(id),
  };
  const servedRead = (await createTranscriptSource(recording).forRender(sessionId, { limit })).entries;
  if (fellBack) return { status: "fallback" };
  const covered = projectTapeEntries(sessionId, rows)?.coveredSeq ?? -1;
  const snapshotLatest = entries.length ? entries[entries.length - 1]!.seq : -1;
  if (covered < snapshotLatest) return { status: "fallback" };
  const served = servedRead.filter((e) => e.seq <= snapshotLatest);
  const floor = served[0]?.seq ?? Number.MAX_SAFE_INTEGER;
  const expected = entries.filter((e) => e.seq >= floor && e.seq <= covered);
  return {
    status: "projected",
    report: classifyDivergences(expected, served, { coarse: coarseTape(rows) }),
  };
}
