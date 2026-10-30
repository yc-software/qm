import { retainedSnapshot } from "../harness/context-snapshot.ts";
import type { SessionEntry } from "../types.ts";

export const memberLabel = (m: { principalId: string; displayName: string; slackId?: string }): string =>
  `${m.displayName} (${[m.principalId, m.slackId].filter(Boolean).join(", ")})`;

export function renderSandboxProviders(
  names: readonly string[],
  defaultName?: string,
  listable = true,
  proxied: readonly string[] = [],
): string {
  if (!names.length) return "";
  const listed = [
    ...names.filter((name) => name === defaultName).map((name) => `${name} (default)`),
    ...names.filter((name) => name !== defaultName).toSorted(),
  ];
  const behindProxy = names.filter((name) => proxied.includes(name)).toSorted();
  const network = behindProxy.length
    ? `\nComputers on ${behindProxy.join(", ")} reach the network only through the egress proxy in $HTTPS_PROXY. If it is https://, Python's urllib and http.client fail there (BadStatusLine, RemoteDisconnected); use curl, git, Python requests, or Node with NODE_USE_ENV_PROXY=1.`
    : "";
  return `## Sandboxes\n${listed.join(", ")}.${listable ? " `sandbox list` for details." : ""}${network}`;
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
  const absentFrom = (list: RosterSnapshot["roster"], id: string) => !list.some((o) => o.id === id);
  const joined = current
    .filter((m) => absentFrom(previous.roster, m.principalId))
    .toSorted((a, b) => a.principalId.localeCompare(b.principalId))
    .map(memberLabel);
  const left = previous.roster.filter((m) => absentFrom(roster, m.id)).map((m) => m.name);
  const parts = [
    joined.length ? `Joined: ${joined.join(", ")}.` : "",
    left.length ? `Left: ${left.join(", ")}.` : "",
  ].filter(Boolean);
  return { text: parts.join(" "), record: { roster, sessionId } };
}

function rosterOf(entry: SessionEntry): RosterSnapshot | undefined {
  const snapshot = (entry.payload as { rosterSnapshot?: Partial<RosterSnapshot> } | null)?.rosterSnapshot;
  return Array.isArray(snapshot?.roster) && typeof snapshot.sessionId === "string"
    ? (snapshot as RosterSnapshot)
    : undefined;
}
