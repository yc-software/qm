import type { DurableMap } from "../../persistence/durable-map.ts";

export interface PromptSnapshot {
  epoch: number;
  frame: string;
  body: string;
}

const CHANGES_BUDGET_CHARS = 4000;
const REMOVED_LINE_CHARS = 160;

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
    const heading = /^(#{1,3}) (.*)$/.exec(text);
    if (heading?.[1] === "###") group = heading[2]!;
    else if (heading) [section, group] = [heading[2]!, ""];
    else lines.push({ label: [section, group].filter(Boolean).join(" › "), text });
  }
  return lines;
}

function minus(from: Labeled[], other: Labeled[]): Labeled[] {
  const left = new Map<string, number>();
  for (const line of other) left.set(`${line.label}\n${line.text}`, (left.get(`${line.label}\n${line.text}`) ?? 0) + 1);
  return from.filter((line) => {
    const key = `${line.label}\n${line.text}`;
    const n = left.get(key) ?? 0;
    left.set(key, n - 1);
    return n <= 0;
  });
}

function rendered(sign: "+" | "-", lines: Labeled[], all: Labeled[]): string[] {
  const out: string[] = [];
  const summarized = new Set<string>();
  for (const line of lines) {
    const total = all.filter((l) => l.label === line.label).length;
    const gone = lines.filter((l) => l.label === line.label).length;
    if (sign === "-" && line.label && total > 1 && gone === total) {
      if (!summarized.has(line.label)) out.push(`- ${line.label}: all ${total} lines`);
      summarized.add(line.label);
      continue;
    }
    const text =
      sign === "-" && line.text.length > REMOVED_LINE_CHARS ? `${line.text.slice(0, REMOVED_LINE_CHARS)}…` : line.text;
    out.push(`${sign} ${line.label ? `${line.label}: ` : ""}${text}`);
  }
  return out;
}

export function promptChanges(snapshot: string, fresh: string): string {
  const before = labeledLines(snapshot);
  const after = labeledLines(fresh);
  const changes = [...rendered("-", minus(before, after), before), ...rendered("+", minus(after, before), after)];
  if (!changes.length) return "";
  const shown: string[] = [];
  let used = 0;
  for (const change of changes) {
    if (used + change.length > CHANGES_BUDGET_CHARS && shown.length) break;
    shown.push(change);
    used += change.length + 1;
  }
  const more = changes.length - shown.length;
  return [
    "## Changed since the system prompt",
    "The system prompt was written earlier in this conversation. For this turn, these lines were removed (-) from it or added (+) to it:",
    ...shown,
    ...(more ? [`…and ${more} more changes; check live inventories before relying on the system prompt's lists.`] : []),
  ].join("\n");
}
