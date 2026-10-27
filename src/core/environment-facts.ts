import type { SessionEntry } from "../types.ts";

export function renderSandboxProviders(names: readonly string[], defaultName?: string): string {
  if (!names.length) return "";
  const listed = names.toSorted().map((name) => (name === defaultName ? `${name} (default)` : name));
  return `## Sandboxes\nProviders: ${listed.join(", ")}. Use \`sandbox list\` for details; the workspace path is $PWD.`;
}

interface RosterSnapshot {
  roster: Array<{ id: string; name: string }>;
}

export function membershipEvent(
  current: ReadonlyArray<{ principalId: string; displayName: string }> | undefined,
  history: readonly SessionEntry[],
): { text: string; record?: RosterSnapshot } {
  if (!current) return { text: "" };
  const record = {
    roster: current.map((m) => ({ id: m.principalId, name: m.displayName })).sort((a, b) => a.id.localeCompare(b.id)),
  };
  const previous = history.findLast((entry) => entry.type === "user" && rosterOf(entry.payload));
  if (!previous) return { text: "", record };
  const before = rosterOf(previous.payload)!;
  const label = (m: { id: string; name: string }) => `${m.name} (${m.id})`;
  const missingFrom = (list: RosterSnapshot["roster"], other: RosterSnapshot["roster"]) =>
    list.filter((m) => !other.some((o) => o.id === m.id)).map(label);
  const joined = missingFrom(record.roster, before);
  const left = missingFrom(before, record.roster);
  const lines = [
    joined.length ? `Joined this conversation since your last turn: ${joined.join(", ")}.` : "",
    left.length ? `Left this conversation since your last turn: ${left.join(", ")}.` : "",
  ].filter(Boolean);
  return { text: lines.join("\n"), record };
}

function rosterOf(payload: unknown): RosterSnapshot["roster"] | undefined {
  const roster = (payload as { environmentSnapshot?: { roster?: unknown } } | null)?.environmentSnapshot?.roster;
  return Array.isArray(roster) ? (roster as RosterSnapshot["roster"]) : undefined;
}
