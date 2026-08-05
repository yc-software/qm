import type { Principal, ScopeId } from "../types.ts";
import type { TapeRecord } from "../sessions/session-store.ts";
import { principalEntitledToScope } from "../resolution/context-filter.ts";
import { INTERRUPTED_TOOL_RESULT } from "./context-compaction.ts";

export function filterTapeForAudience(
  rows: readonly TapeRecord[],
  audience: readonly Principal[],
  sessionScopeId: ScopeId,
  orgScopeId: ScopeId,
): TapeRecord[] {
  if (audience.length === 0) return [];
  const out: TapeRecord[] = [];
  for (const r of rows) {
    if (
      r.kind !== "message" ||
      audience.every((p) => principalEntitledToScope(p, r.scopeLabel, sessionScopeId, orgScopeId))
    ) {
      out.push(r);
      continue;
    }
    const msg = r.payload as { role?: string; toolCallId?: string; toolName?: string } | null;
    if (msg?.role === "toolResult" && typeof msg.toolCallId === "string") {
      out.push({
        ...r,
        payload: {
          role: "toolResult",
          toolCallId: msg.toolCallId,
          toolName: typeof msg.toolName === "string" ? msg.toolName : "tool",
          content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT }],
          isError: true,
          timestamp: r.createdAt,
        },
      });
    }
  }
  return out;
}

export function lastImportLacksScopes(rows: readonly TapeRecord[]): boolean {
  const lastImport = rows.findLast((r) => contextEvent(r)?.event === "legacy_import");
  return !!lastImport && !Array.isArray((lastImport.payload as { scopes?: unknown }).scopes);
}

export function tapeEventsEntitled(
  rows: readonly TapeRecord[],
  audience: readonly Principal[],
  sessionScopeId: ScopeId,
  orgScopeId: ScopeId,
): boolean {
  if (audience.length === 0) return false;
  const entitled = (scope: ScopeId): boolean =>
    audience.every((p) => principalEntitledToScope(p, scope, sessionScopeId, orgScopeId));
  const lastImport = rows.findLastIndex((r) => contextEvent(r)?.event === "legacy_import");
  return rows.every((r, i) => {
    if (lastImport >= 0 && i < lastImport) return true;
    const ev = contextEvent(r);
    if (!ev || ev.event === "interrupt") return true;
    if (!entitled(r.scopeLabel)) return false;
    if (ev.event === "legacy_import" || ev.event === "legacy_patch") {
      const scopes = (r.payload as { scopes?: unknown }).scopes;
      return Array.isArray(scopes) && scopes.every((s) => typeof s === "string" && entitled(s as ScopeId));
    }
    return true;
  });
}

export interface RehydratedTapeImage {
  data: string;
  mimeType: string;
  sizeBytes: number;
}

export const ELIDED_IMAGE_TEXT =
  "[image removed: this conversation's images no longer fit the model's request-size limit; ask for it to be re-shared if needed]";

export async function rehydrateFoldImages(
  messages: readonly unknown[],
  load: (artifactRef: string, maxBytes: number) => Promise<RehydratedTapeImage | "over-budget" | null>,
  maxBytes: number,
): Promise<unknown[]> {
  const isStripped = (b: unknown): b is { artifactRef: string; mimeType?: unknown } => {
    const image = b as { type?: string; data?: unknown; artifactRef?: unknown };
    return image?.type === "image" && typeof image.data !== "string" && typeof image.artifactRef === "string";
  };
  const isOmitted = (b: unknown): boolean => {
    const image = b as { type?: string; data?: unknown; artifactRef?: unknown; omitted?: unknown };
    return (
      image?.type === "image" &&
      typeof image.data !== "string" &&
      typeof image.artifactRef !== "string" &&
      image.omitted === true
    );
  };
  const candidates: Array<{ msg: number; block: number }> = [];
  const replacements = new Map<string, unknown>();
  messages.forEach((original, msg) => {
    const content = (original as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) return;
    content.forEach((b, block) => {
      if (isStripped(b)) candidates.push({ msg, block });
      else if (isOmitted(b)) replacements.set(`${msg}:${block}`, { type: "text", text: ELIDED_IMAGE_TEXT });
    });
  });
  if (!candidates.length && !replacements.size) return [...messages];

  const cached = new Map<string, RehydratedTapeImage | "over-budget" | null>();
  let remainingBytes = maxBytes;
  for (const pos of [...candidates].reverse()) {
    const content = (messages[pos.msg] as { content: unknown[] }).content;
    const block = content[pos.block] as { artifactRef: string; mimeType?: unknown };
    const budgetSpent = remainingBytes <= 0;
    let loaded: RehydratedTapeImage | "over-budget" | null = null;
    if (!budgetSpent) {
      if (!cached.has(block.artifactRef)) cached.set(block.artifactRef, await load(block.artifactRef, remainingBytes));
      loaded = cached.get(block.artifactRef) ?? null;
    }
    const image = loaded !== "over-budget" ? loaded : null;
    if (
      image &&
      image.sizeBytes > 0 &&
      image.sizeBytes <= remainingBytes &&
      typeof block.mimeType === "string" &&
      block.mimeType === image.mimeType
    ) {
      remainingBytes -= image.sizeBytes;
      const { artifactRef: _artifactRef, omitted: _omitted, ...rest } = block as Record<string, unknown>;
      replacements.set(`${pos.msg}:${pos.block}`, { ...rest, data: image.data, mimeType: image.mimeType });
    } else if (budgetSpent || loaded === "over-budget" || (image && image.sizeBytes > remainingBytes)) {
      replacements.set(`${pos.msg}:${pos.block}`, { type: "text", text: ELIDED_IMAGE_TEXT });
    }
  }

  return messages.map((original, msg) => {
    const message = original as { content?: unknown } | null;
    if (!Array.isArray(message?.content)) return original;
    let changed = false;
    const content = message.content.map((block, i) => {
      const swap = replacements.get(`${msg}:${i}`);
      if (swap !== undefined) changed = true;
      return swap ?? block;
    });
    return changed ? { ...(original as Record<string, unknown>), content } : original;
  });
}

interface CompactionEvent {
  event: "compaction";
  text: string;
}
interface LegacyImportEvent {
  event: "legacy_import";
  messages: unknown[];
}
interface LegacyPatchEvent {
  event: "legacy_patch";
  messages: unknown[];
}
interface InterruptEvent {
  event: "interrupt";
}
type TapeEvent = CompactionEvent | LegacyImportEvent | LegacyPatchEvent | InterruptEvent;

function contextEvent(row: TapeRecord): TapeEvent | null {
  if (row.kind !== "context_event") return null;
  const p = row.payload as { event?: unknown } | null;
  if (
    p?.event === "compaction" ||
    p?.event === "legacy_import" ||
    p?.event === "legacy_patch" ||
    p?.event === "interrupt"
  ) {
    return row.payload as TapeEvent;
  }
  return null;
}

type Foldable = { out: unknown[]; boundaries: Array<{ pos: number; entrySeq: number }> };

function assistantDroppedAtReplay(m: unknown): boolean {
  const msg = m as { role?: string; stopReason?: string };
  return msg?.role === "assistant" && (msg.stopReason === "aborted" || msg.stopReason === "error");
}

function healDanglingCalls(out: unknown[], at: number): void {
  const answered = new Set<string>();
  for (const m of out) {
    const msg = m as { role?: string; toolCallId?: string };
    if (msg?.role === "toolResult" && typeof msg.toolCallId === "string") answered.add(msg.toolCallId);
  }
  const missing: Array<{ id: string; name: string }> = [];
  for (const m of out) {
    const msg = m as { role?: string; content?: unknown };
    if (msg?.role !== "assistant" || !Array.isArray(msg.content) || assistantDroppedAtReplay(m)) continue;
    for (const block of msg.content) {
      const b = block as { type?: string; id?: string; name?: string };
      if (b?.type === "toolCall" && typeof b.id === "string" && !answered.has(b.id)) {
        missing.push({ id: b.id, name: b.name ?? "tool" });
      }
    }
  }
  for (const m of missing) {
    out.push({
      role: "toolResult",
      toolCallId: m.id,
      toolName: m.name,
      content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT }],
      isError: true,
      timestamp: at,
    });
  }
}

export function foldTape(rows: readonly TapeRecord[]): unknown[] {
  const f: Foldable = { out: [], boundaries: [] };
  for (const row of rows) {
    if (row.kind === "annotation") {
      if ((row.payload as { turnEnd?: unknown } | null)?.turnEnd === true && row.entrySeq !== undefined) {
        f.boundaries.push({ pos: f.out.length, entrySeq: row.entrySeq });
      }
      continue;
    }
    const ev = contextEvent(row);
    if (ev) {
      if (ev.event === "legacy_import") {
        f.out = [...(ev.messages ?? [])];
        f.boundaries = row.coversEntrySeq !== undefined ? [{ pos: f.out.length, entrySeq: row.coversEntrySeq }] : [];
      } else if (ev.event === "legacy_patch") {
        f.out.push(...(ev.messages ?? []));
        if (row.coversEntrySeq !== undefined) f.boundaries.push({ pos: f.out.length, entrySeq: row.coversEntrySeq });
      } else if (ev.event === "compaction") {
        const cut =
          row.coversEntrySeq !== undefined
            ? [...f.boundaries].reverse().find((b) => b.entrySeq <= row.coversEntrySeq!)
            : undefined;
        const kept = cut ? f.out.slice(cut.pos) : [...f.out];
        f.out = [
          {
            role: "user",
            content: [{ type: "text", text: `[Earlier conversation summary]\n${ev.text}` }],
            timestamp: row.createdAt,
          },
          ...kept,
        ];
        f.boundaries = cut
          ? f.boundaries
              .filter((b) => b.pos >= cut.pos)
              .map((b) => ({ pos: b.pos - cut.pos + 1, entrySeq: b.entrySeq }))
          : f.boundaries.map((b) => ({ pos: b.pos + 1, entrySeq: b.entrySeq }));
      } else {
        healDanglingCalls(f.out, row.createdAt);
      }
      continue;
    }
    if (row.kind === "message" && row.payload != null) f.out.push(row.payload);
  }
  return f.out;
}

export function planTapeSeed(
  rows: readonly TapeRecord[],
  harness: string,
  mode: "shadow" | "serve" | undefined,
  folded?: readonly unknown[],
): { seed: unknown[] | null; skip?: "foreign-harness"; lint?: FoldLint; fold?: unknown[] } {
  if (rows.some((r) => r.kind === "message" && r.harness !== undefined && r.harness !== harness)) {
    return { seed: null, skip: "foreign-harness" };
  }
  const fold = folded ? [...folded] : foldTape(rows);
  const lint = lintFold(fold);
  return { seed: mode === "serve" && lint.ok && fold.length ? fold : null, lint, fold };
}

export function tapeNeedsInterruptHeal(rows: readonly TapeRecord[], folded?: readonly unknown[]): boolean {
  const problems = lintFold(folded ?? foldTape(rows)).problems;
  return problems.length > 0 && problems.every((p) => p.startsWith("end:"));
}

export function healFoldInterrupt(messages: readonly unknown[], at: number): unknown[] {
  const healed = [...messages];
  healDanglingCalls(healed, at);
  return healed;
}

export interface FoldLint {
  ok: boolean;
  problems: string[];
}

export function lintFold(messages: readonly unknown[]): FoldLint {
  const problems: string[] = [];
  const openCalls = new Set<string>();
  const seenCallIds = new Set<string>();
  const first = messages[0] as { role?: string } | undefined;
  if (first && first.role !== "user")
    problems.push(`#0: first message must be user-role, got ${JSON.stringify(first.role)}`);
  messages.forEach((m, i) => {
    const msg = m as { role?: string; content?: unknown; toolCallId?: string };
    if (msg?.role !== "user" && msg?.role !== "assistant" && msg?.role !== "toolResult") {
      problems.push(`#${i}: unknown role ${JSON.stringify(msg?.role)}`);
      return;
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as { type?: string; data?: unknown };
        if (b?.type === "image" && typeof b.data !== "string") {
          problems.push(`#${i}: image block without bytes`);
        }
      }
    }
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as { type?: string; id?: string };
        if (b?.type === "toolCall" && typeof b.id === "string") {
          if (seenCallIds.has(b.id)) problems.push(`#${i}: duplicate tool call id ${b.id}`);
          seenCallIds.add(b.id);
          if (!assistantDroppedAtReplay(m)) openCalls.add(b.id);
        }
      }
    } else if (msg.role === "toolResult") {
      if (typeof msg.toolCallId !== "string" || !openCalls.delete(msg.toolCallId)) {
        problems.push(`#${i}: toolResult without a preceding open call (${String(msg.toolCallId)})`);
      }
    } else if (msg.role === "user" && openCalls.size) {
      problems.push(`#${i}: user message while ${openCalls.size} tool call(s) await results`);
      openCalls.clear();
    }
  });
  if (openCalls.size) problems.push(`end: ${openCalls.size} dangling tool call(s)`);
  return { ok: problems.length === 0, problems };
}
