import { retainedSnapshot } from "../harness/context-snapshot.ts";
import type { SessionEntry } from "../types.ts";

export function renderSandboxProviders(names: readonly string[], defaultName?: string): string {
  if (!names.length) return "";
  const listed = names.toSorted().map((name) => (name === defaultName ? `${name} (default)` : name));
  return `## Sandboxes\nProviders: ${listed.join(", ")}. Use \`sandbox list\` for details; the workspace path is $PWD.`;
}

export function renderConnectableApps(labels: readonly string[]): string {
  return labels.length
    ? `Direct OAuth apps you may offer with the connect-apps skill: ${labels.toSorted().join(", ")}.`
    : "No direct OAuth apps are configured; offer no direct OAuth consent links.";
}

interface RosterSnapshot {
  roster: Array<{ id: string; name: string }>;
  sessionId: string;
}

export function membershipEvent(
  current: ReadonlyArray<{ principalId: string; displayName: string }> | undefined,
  history: readonly SessionEntry[],
  sessionId: string,
): { text: string; record?: RosterSnapshot } {
  if (!current) return { text: "" };
  const roster = current
    .map((m) => ({ id: m.principalId, name: m.displayName }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const { previous } = retainedSnapshot(history, rosterOf);
  if (!previous) return { text: "", record: { roster, sessionId } };
  const label = (m: { id: string; name: string }) => `${m.name} (${m.id})`;
  const missingFrom = (list: RosterSnapshot["roster"], other: RosterSnapshot["roster"]) =>
    list.filter((m) => !other.some((o) => o.id === m.id)).map(label);
  const joined = missingFrom(roster, previous.roster);
  const left = missingFrom(previous.roster, roster);
  const lines = [
    joined.length ? `Joined this conversation since your last turn: ${joined.join(", ")}.` : "",
    left.length ? `Left this conversation since your last turn: ${left.join(", ")}.` : "",
  ].filter(Boolean);
  return { text: lines.join("\n"), record: { roster, sessionId } };
}

function rosterOf(entry: SessionEntry): RosterSnapshot | undefined {
  const snapshot = (entry.payload as { environmentSnapshot?: Partial<RosterSnapshot> } | null)?.environmentSnapshot;
  return Array.isArray(snapshot?.roster) && typeof snapshot.sessionId === "string"
    ? (snapshot as RosterSnapshot)
    : undefined;
}
