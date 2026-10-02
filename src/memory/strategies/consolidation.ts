import { randomUUID } from "node:crypto";
import { type MemoryRecords } from "../records.ts";
import type { ScopeId } from "../../types.ts";
import type { HarnessModelUtilities } from "../../harness/harness.ts";
import type { MemoryService } from "../memory-service.ts";
import { createKeyedQueue } from "../../util/async.ts";
import { bulletText, captureDate, dateStr, isBullet } from "../notebook.ts";

export const DEFAULT_CONSOLIDATE_AFTER = 10;

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
  "- A fact recording the user's own words instructing the assistant — a standing rule,",
  "  preference, or directive about how future work should be done — must survive VERBATIM:",
  "  never DELETE it and never reword it in an UPDATE. One exception: when two such facts",
  "  duplicate each other, keep one verbatim and DELETE the redundant copy — unless they carry",
  "  different `(said in …)` sources, in which case keep both.",
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

function applyRecordActions(records: MemoryRecords["records"], actions: ConsolidationAction[], at: number) {
  const updates = new Map<number, string>();
  const deletes = new Set<number>();
  const added: MemoryRecords["records"] = [];
  for (const action of actions) {
    if (action.kind === "update") updates.set(action.index, action.text);
    else if (action.kind === "delete") deletes.add(action.index);
    else if (records[0]) added.push({ ...records[0], id: randomUUID(), text: formatBullet(action.text, dateStr(at)) });
  }
  return [
    ...records.flatMap((record, index) => {
      if (deletes.has(index + 1)) return [];
      const text = updates.get(index + 1);
      return [
        {
          ...record,
          ...(text === undefined
            ? {}
            : { text: formatBullet(text, captureDate(bulletText(record.text)) ?? dateStr(at)) }),
        },
      ];
    }),
    ...added,
  ];
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
}): Consolidator | undefined {
  const afterN = deps.afterN ?? DEFAULT_CONSOLIDATE_AFTER;
  if (afterN <= 0) return undefined;
  const now = deps.now ?? Date.now;
  async function maintain(scopeId: ScopeId): Promise<void> {
    if (!deps.harness.oneShot || !deps.memory.replaceRecordsIfRevision) return;
    const head = await deps.memory.readHead?.(scopeId);
    if (!head?.records?.records.some((record) => isBullet(record.text))) return;
    const at = now();
    const classify = async (records: MemoryRecords["records"]) => {
      const numbered = records.map((record, index) => `${index + 1}. ${bulletText(record.text)}`).join("\n");
      const out = await deps.harness.oneShot!(MEMORY_CONSOLIDATION_PROMPT, numbered).catch(() => "");
      return parseConsolidationActions(out ?? "");
    };
    {
      const groups = new Map<string, MemoryRecords["records"]>();
      for (const record of head.records.records.filter((record) => isBullet(record.text))) {
        const key = JSON.stringify([
          record.sensitivity,
          record.sourceUnknown,
          record.sources.map((source) => [source.scopeId, source.sessionId ?? ""]).sort(),
        ]);
        const group = groups.get(key) ?? [];
        group.push(record);
        groups.set(key, group);
      }
      const revised = new Map<string, MemoryRecords["records"][number]>();
      const added: MemoryRecords["records"] = [];
      const existing = new Set(head.records.records.map((record) => record.id));
      for (const group of groups.values()) {
        for (const record of applyRecordActions(group, await classify(group), at)) {
          if (existing.has(record.id)) revised.set(record.id, record);
          else added.push(record);
        }
      }
      const records = head.records.records.flatMap((record) => {
        if (!isBullet(record.text)) return [record];
        return revised.has(record.id) ? [revised.get(record.id)!] : [];
      });
      records.push(...added);
      await deps.memory.replaceRecordsIfRevision(
        scopeId,
        { ...head.records, records, capturesSinceConsolidation: 0 },
        head.revision,
        "system",
      );
      return;
    }
  }

  return {
    maintain,
    async maybeMaintain(scopeId) {
      const head = await deps.memory.readHead?.(scopeId);
      if (!head?.records) return;
      const count =
        head.records.capturesSinceConsolidation ??
        head.records.records.filter((record) => isBullet(record.text)).length;
      if (count >= afterN) await maintain(scopeId);
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
    async capture(s, facts, at, author, context) {
      const added = await perScope(s, () => base.capture(s, facts, at, author, context));
      if (added > 0) void perScope(s, () => consolidator.maybeMaintain(s)).catch(() => {});
      return added;
    },
    replace: (s, content, author) => perScope(s, () => base.replace(s, content, author)),
  };
  return { memory, maintain: (s) => perScope(s, () => consolidator.maintain(s)) };
}
