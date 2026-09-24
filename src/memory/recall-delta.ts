import type { SessionEntry } from "../types.ts";

interface RecallRecord {
  body: string;
  anchorSeq?: number;
}

function facts(body: string): Map<string, string> {
  const result = new Map<string, string>();
  const headings: string[] = [];
  let scope = "";
  let pending: string[] = [];
  const flush = () => {
    const text = pending.join("\n").trim();
    if (text) {
      const rendered = [scope, ...headings.filter(Boolean), text].filter(Boolean).join("\n");
      result.set(rendered, rendered);
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
    } else if (!line.trim() || /^[-*]\s/.test(line)) {
      flush();
      if (line.trim()) pending.push(line);
    } else pending.push(line);
  }
  flush();
  return result;
}

export function memoryRecallDelta(
  body: string,
  history: readonly SessionEntry[],
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
  if (!retained || !previous) return { text: body, record };
  if (previous.body === body) return { text: "", record };
  const oldFacts = facts(previous.body);
  const newFacts = facts(body);
  const added = [...newFacts].filter(([key]) => !oldFacts.has(key)).map(([, text]) => text);
  const removed = [...oldFacts].filter(([key]) => !newFacts.has(key)).map(([, text]) => text);
  return {
    text: [
      added.length ? `New or updated memory facts:\n\n${added.join("\n\n")}` : "",
      removed.length
        ? "Some previously recalled memory facts have been withdrawn or are no longer included. Do not rely on earlier memory that is absent from the current authorized notebook."
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    record,
  };
}
