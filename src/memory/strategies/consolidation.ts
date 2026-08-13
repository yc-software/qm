import type { ScopeId } from "../../types.ts";
import type { HarnessModelUtilities } from "../../harness/harness.ts";
import type { MemoryService } from "../memory-service.ts";
import { createKeyedQueue } from "../../util/async.ts";
import { bulletText, captureDate, dateStr, isBullet } from "../notebook.ts";

export const DEFAULT_CONSOLIDATE_AFTER = 10;

const MARKER_PREFIX = "<!-- consolidated:";

export function consolidationMarker(at: number): string {
  return `${MARKER_PREFIX} ${dateStr(at)} -->`;
}

function isMarker(line: string): boolean {
  return line.trim().startsWith(MARKER_PREFIX);
}

export function bulletsBelowMarker(body: string): number {
  const lines = body.split("\n");
  let lastMarker = -1;
  for (let i = 0; i < lines.length; i++) if (isMarker(lines[i]!)) lastMarker = i;
  return lines.slice(lastMarker + 1).filter(isBullet).length;
}

export const MEMORY_CONSOLIDATION_PROMPT = [
  "You consolidate an agent's long-term memory notebook. The input is a numbered list",
  "of remembered facts (each may start with a (YYYY-MM-DD) capture date).",
  "Output ONLY actions, one per line, in these exact forms:",
  "UPDATE <n>: <revised fact>",
  "DELETE <n>",
  "ADD: <new fact>",
  "If nothing needs changing, output exactly: NONE",
  "",
  "Rules:",
  "- Prefer UPDATE over DELETE+ADD when a fact has evolved or two facts should merge",
  "  (UPDATE one, DELETE the other).",
  "- Keep facts atomic: one standalone fact per line. Split a compound fact with an",
  "  UPDATE plus ADDs.",
  "- DELETE facts that are stale, contradicted by newer facts, exact or near",
  "  duplicates, or trivially derivable from other facts.",
  "- DELETE pure system mechanics that can be looked up when needed (API endpoints/headers,",
  "  credential/broker plumbing, state-file paths, tool invocation details) — but KEEP",
  "  user-stated conventions about them, and keep one existence-level fact for a standing",
  "  system the user relies on (a cron, a watcher, an integration).",
  "- NEVER delete or weaken a fact the user explicitly asked to remember.",
  "- Preserve any `(said in …)` suffix verbatim — it records where a fact was stated and",
  "  scopes it. Keep it through an UPDATE, and never merge two facts that carry different",
  "  `(said in …)` sources.",
  "- Do not reword facts that are already fine. When in doubt, leave a fact alone.",
].join("\n");

export type ConsolidationAction =
  { kind: "update"; index: number; text: string } | { kind: "delete"; index: number } | { kind: "add"; text: string };

export function parseConsolidationActions(out: string): ConsolidationAction[] {
  const actions: ConsolidationAction[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line || /^none$/i.test(line)) continue;
    let m = /^UPDATE\s+(\d+)\s*:\s*(.+)$/i.exec(line);
    if (m) {
      actions.push({ kind: "update", index: Number(m[1]), text: m[2]!.trim() });
      continue;
    }
    m = /^DELETE\s+(\d+)\s*$/i.exec(line);
    if (m) {
      actions.push({ kind: "delete", index: Number(m[1]) });
      continue;
    }
    m = /^ADD\s*:\s*(.+)$/i.exec(line);
    if (m) actions.push({ kind: "add", text: m[1]!.trim() });
  }
  return actions;
}

function formatBullet(text: string, date: string): string {
  return captureDate(text) ? `- ${text}` : `- (${date}) ${text}`;
}

export function applyConsolidationActions(body: string, actions: ConsolidationAction[], at: number): string {
  const today = dateStr(at);
  const updates = new Map<number, string>();
  const deletes = new Set<number>();
  const adds: string[] = [];
  for (const a of actions) {
    if (a.kind === "update") updates.set(a.index, a.text);
    else if (a.kind === "delete") deletes.add(a.index);
    else adds.push(a.text);
  }

  const out: string[] = [];
  let n = 0;
  for (const line of body.split("\n")) {
    if (isMarker(line)) {
      if (out[out.length - 1]?.trim() === "") out.pop();
      continue;
    }
    if (!isBullet(line)) {
      out.push(line);
      continue;
    }
    n++;
    if (deletes.has(n)) continue;
    const updated = updates.get(n);
    out.push(updated !== undefined ? formatBullet(updated, captureDate(bulletText(line)) ?? today) : line);
  }
  for (const text of adds) out.push(formatBullet(text, today));

  const trimmed = out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "");
  return `${trimmed}\n\n${consolidationMarker(at)}`;
}

export interface Consolidator {
  maintain(scopeId: ScopeId): Promise<void>;
  maybeMaintain(scopeId: ScopeId): Promise<void>;
}

export function createConsolidator(deps: {
  harness: HarnessModelUtilities;
  memory: MemoryService;
  afterN?: number;
  now?: () => number;
  log?: (msg: string) => void;
}): Consolidator | undefined {
  const afterN = deps.afterN ?? DEFAULT_CONSOLIDATE_AFTER;
  if (afterN <= 0) return undefined;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((msg: string) => console.error(msg));
  const degraded = new Set<ScopeId>();
  async function maintain(scopeId: ScopeId): Promise<void> {
    if (degraded.has(scopeId) || !deps.harness.oneShot) return;
    const guarded = deps.memory.readHead && deps.memory.replaceIfRevision;
    const head = guarded ? await deps.memory.readHead!(scopeId) : undefined;
    const body = head?.content ?? (await deps.memory.read(scopeId));
    const bullets = body.split("\n").filter(isBullet);
    if (!bullets.length) return;

    const numbered = bullets.map((l, i) => `${i + 1}. ${bulletText(l)}`).join("\n");
    let out: string | undefined;
    try {
      out = await deps.harness.oneShot(MEMORY_CONSOLIDATION_PROMPT, numbered);
    } catch {
      return;
    }
    const at = now();
    const next = applyConsolidationActions(body, parseConsolidationActions(out ?? ""), at);
    if (head) {
      await deps.memory.replaceIfRevision!(scopeId, next, head.revision, "system");
      return;
    }
    await deps.memory.replace(scopeId, next, "system");

    const after = await deps.memory.read(scopeId);
    if (after.replace(/\s+$/, "") !== next.replace(/\s+$/, "")) {
      degraded.add(scopeId);
      log(`[memory] store for ${scopeId} does not support rewrite; consolidation disabled (capture-only)`);
    }
  }

  return {
    maintain,
    async maybeMaintain(scopeId) {
      if (degraded.has(scopeId)) return;
      if (bulletsBelowMarker(await deps.memory.read(scopeId)) >= afterN) await maintain(scopeId);
    },
  };
}

export function createConsolidatingMemory(
  base: MemoryService,
  consolidator: Consolidator | undefined,
): { memory: MemoryService; maintain?: (scopeId: ScopeId) => Promise<void> } {
  if (!consolidator) return { memory: base };
  const perScope = createKeyedQueue<ScopeId>();
  const memory: MemoryService = {
    ...base,
    async capture(s, facts, at, author) {
      const added = await perScope(s, () => base.capture(s, facts, at, author));
      if (added > 0) void perScope(s, () => consolidator.maybeMaintain(s)).catch(() => {});
      return added;
    },
    replace: (s, content, author) => perScope(s, () => base.replace(s, content, author)),
  };
  return { memory, maintain: (s) => perScope(s, () => consolidator.maintain(s)) };
}
