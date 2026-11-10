import type { DurableMap } from "../../persistence/durable-map.ts";

export interface PromptSnapshot {
  epoch: number;
  frame: string;
  body: string;
}

export async function systemPromptSnapshot(
  store: DurableMap<PromptSnapshot>,
  sessionId: string,
  fresh: PromptSnapshot,
): Promise<PromptSnapshot> {
  const kept = (await store.get(sessionId)) ?? (await store.putIfAbsent(sessionId, fresh));
  if (kept.epoch >= fresh.epoch) return kept;
  return (await store.update(sessionId, (current) => (current.epoch >= fresh.epoch ? current : fresh))) ?? fresh;
}

export function turnFrameNote(frame: string): string {
  return `This turn runs differently from the session described at the top of the system prompt; this applies instead:\n${frame}`;
}

interface Labeled {
  label: string;
  text: string;
}

function labeledLines(prompt: string): Labeled[] {
  let section = "";
  let group = "";
  const lines: Labeled[] = [];
  for (const text of prompt.split("\n")) {
    if (!text.trim()) continue;
    if (text.startsWith("### ")) group = text.slice(4);
    else if (text.startsWith("## ") || text.startsWith("# "))
      [section, group] = [text.slice(text.indexOf(" ") + 1), ""];
    else lines.push({ label: [section, group].filter(Boolean).join(" › "), text });
  }
  return lines;
}

function minus(from: Labeled[], other: Labeled[]): Labeled[] {
  const left = new Map<string, number>();
  const key = (line: Labeled) => `${line.label}\n${line.text}`;
  for (const line of other) left.set(key(line), (left.get(key(line)) ?? 0) + 1);
  return from.filter((line) => {
    const n = left.get(key(line)) ?? 0;
    left.set(key(line), n - 1);
    return n <= 0;
  });
}

export function promptChanges(snapshot: string, fresh: string): string {
  const before = labeledLines(snapshot);
  const removed = minus(before, labeledLines(fresh));
  const added = minus(labeledLines(fresh), before);
  if (!removed.length && !added.length) return "";
  const grouped = (lines: Labeled[], verb: "Removed" | "Added") =>
    [...new Set(lines.map((l) => l.label))].flatMap((label) => {
      const texts = lines.filter((l) => l.label === label).map((l) => l.text);
      const total = before.filter((l) => l.label === label).length;
      if (!label) return [`${verb}:`, ...texts];
      if (verb === "Removed" && total > 1 && texts.length === total) return [`Removed all of "${label}".`];
      return [`${verb} ${verb === "Removed" ? "from" : "to"} "${label}":`, ...texts];
    });
  return ["## Changed since the system prompt", ...grouped(removed, "Removed"), ...grouped(added, "Added")].join("\n");
}
