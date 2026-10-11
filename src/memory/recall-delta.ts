import type { SessionEntry } from "../types.ts";
import { isMemoryBookkeeping } from "./notebook.ts";

interface RecallRecord {
  body: string;
  anchorSeq?: number;
}

interface Fact {
  scope: string;
  header: string;
  text: string;
}

function facts(body: string): Map<string, Fact> {
  const result = new Map<string, Fact>();
  const headings: string[] = [];
  let scope = "";
  let pending: string[] = [];
  const flush = () => {
    const text = pending.join("\n").trim();
    if (text) {
      const header = [scope, ...headings.filter(Boolean)].filter(Boolean).join("\n");
      result.set(`${header}\n${text}`, { scope: scope.slice(4), header, text });
    }
    pending = [];
  };
  for (const line of body.split("\n")) {
    if (/^### [^\s:]+:/.test(line)) {
      flush();
      scope = line;
      headings.length = 0;
      continue;
    }
    const heading = /^(#{1,6})\s/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      headings.length = level;
      headings[level - 1] = line;
    } else if (!line.trim() || isMemoryBookkeeping(line) || /^[-*]\s/.test(line)) {
      flush();
      if (line.trim() && !isMemoryBookkeeping(line)) pending.push(line);
    } else pending.push(line);
  }
  flush();
  return result;
}

function render(list: Iterable<Fact>): string {
  const groups = new Map<string, string[]>();
  for (const { header, text } of list) groups.set(header, [...(groups.get(header) ?? []), text]);
  return [...groups].map(([header, texts]) => [header, ...texts].filter(Boolean).join("\n")).join("\n\n");
}

export function memoryRecallDelta(
  body: string,
  history: readonly SessionEntry[],
  authorizedScopes: readonly string[] = [...body.matchAll(/^### ([^\s:]+:[^\n]+)$/gm)].map((match) => match[1]!),
): { text: string; record: RecallRecord } {
  const previousEntry = history.findLast(
    (entry) =>
      entry.type === "user" &&
      typeof (entry.payload as { memoryRecall?: RecallRecord } | null)?.memoryRecall?.body === "string",
  );
  const previous = (previousEntry?.payload as { memoryRecall?: RecallRecord } | undefined)?.memoryRecall;
  const anchorSeq = previous?.anchorSeq ?? previousEntry?.seq;
  const retained = anchorSeq !== undefined && history.some((entry) => entry.seq === anchorSeq);
  const record = { body, ...(retained ? { anchorSeq } : {}) };
  const newFacts = facts(body);
  if (!retained || !previous) return { text: render(newFacts.values()), record };
  if (previous.body === body) return { text: "", record };
  const oldFacts = facts(previous.body);
  const added = [...newFacts].filter(([key]) => !oldFacts.has(key)).map(([, fact]) => fact);
  const removed = new Map<string, number>();
  for (const [key, { scope }] of oldFacts) if (!newFacts.has(key)) removed.set(scope, (removed.get(scope) ?? 0) + 1);
  const withdrawn = [...removed].filter(([scope]) => authorizedScopes.includes(scope));
  return {
    text: [
      added.length ? `New or updated memory facts:\n\n${render(added)}` : "",
      withdrawn
        .map(
          ([scope, n]) =>
            `${scope}: ${n} earlier ${n === 1 ? "fact was" : "facts were"} consolidated or removed; rely only on the current list.`,
        )
        .join("\n"),
      removed.size > withdrawn.length
        ? "Some previously recalled memory sources are no longer included. Do not rely on memory from sources that are not currently authorized."
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    record,
  };
}
