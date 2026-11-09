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
  const kept = await store.putIfAbsent(sessionId, fresh);
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
  const count = (lines: Labeled[], label: string) => lines.filter((line) => line.label === label).length;
  const line = (sign: string, { label, text }: Labeled) => `${sign} ${label ? `${label}: ` : ""}${text}`;
  const gone = new Set(
    removed.filter((l) => l.label && count(before, l.label) > 1 && count(removed, l.label) === count(before, l.label)),
  );
  const summarized = [...new Set([...gone].map((l) => l.label))];
  return [
    "## Changed since the system prompt",
    "The system prompt was written earlier in this conversation. For this turn, these lines were removed (-) from it or added (+) to it:",
    ...summarized.map((label) => `- ${label}: all ${count(before, label)} lines`),
    ...removed.filter((l) => !gone.has(l)).map((l) => line("-", l)),
    ...added.map((l) => line("+", l)),
  ].join("\n");
}
