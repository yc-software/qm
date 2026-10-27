import { retainedSnapshot } from "../harness/context-snapshot.ts";
import type { SessionEntry } from "../types.ts";

export function renderSandboxProviders(names: readonly string[], defaultName?: string): string {
  if (!names.length) return "";
  const listed = [
    ...names.filter((name) => name === defaultName).map((name) => `${name} (default)`),
    ...names.filter((name) => name !== defaultName).toSorted(),
  ];
  return `## Sandboxes\n${listed.join(", ")}. \`sandbox list\` for details.`;
}

interface RosterSnapshot {
  roster: Array<{ id: string; name: string }>;
  sessionId: string;
}

export function membershipEvent(
  current: ReadonlyArray<{ principalId: string; displayName: string; slackId?: string }> | undefined,
  history: readonly SessionEntry[],
  sessionId: string,
): { text: string; record?: RosterSnapshot } {
  if (!current) return { text: "" };
  const roster = current
    .map((m) => ({ id: m.principalId, name: m.displayName }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const { previous } = retainedSnapshot(history, rosterOf);
  if (!previous) return { text: "", record: { roster, sessionId } };
  const isNew = (list: RosterSnapshot["roster"]) => (m: { id: string }) => !list.some((o) => o.id === m.id);
  const joined = current
    .filter((m) => isNew(previous.roster)({ id: m.principalId }))
    .toSorted((a, b) => a.principalId.localeCompare(b.principalId))
    .map((m) => `${m.displayName} (${m.slackId ?? m.principalId})`);
  const left = previous.roster.filter(isNew(roster)).map((m) => m.name);
  const parts = [
    joined.length ? `Joined: ${joined.join(", ")}.` : "",
    left.length ? `Left: ${left.join(", ")}.` : "",
  ].filter(Boolean);
  return { text: parts.join(" "), record: { roster, sessionId } };
}

function rosterOf(entry: SessionEntry): RosterSnapshot | undefined {
  const snapshot = (entry.payload as { environmentSnapshot?: Partial<RosterSnapshot> } | null)?.environmentSnapshot;
  return Array.isArray(snapshot?.roster) && typeof snapshot.sessionId === "string"
    ? (snapshot as RosterSnapshot)
    : undefined;
}
