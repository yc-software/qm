export interface SwarmPeer {
  id: string;
  parentId?: string;
  sessionId?: string;
  sessionUrl?: string;
  state: "reserved" | "ready" | "failed";
  control?: "paused" | "stopped";
  running?: boolean;
  depth: number;
}

export interface SwarmView {
  id: string;
  self: SwarmPeer;
  peers: SwarmPeer[];
  board?: { sandboxId: string };
  expiresAt?: number;
}

export type Status = "running" | "idle" | "starting" | "paused" | "stopped" | "failed" | "expired";

const ORDER: Status[] = ["running", "idle", "starting", "paused", "stopped", "failed", "expired"];

function expired(view: SwarmView, now: number): boolean {
  return view.expiresAt !== undefined && now >= view.expiresAt;
}

function effective(peer: SwarmPeer, inherited: Status, isExpired: boolean): Status {
  if (peer.control === "stopped" || inherited === "stopped") return "stopped";
  if (peer.state === "failed") return "failed";
  if (isExpired) return "expired";
  if (peer.control === "paused" || inherited === "paused") return "paused";
  if (peer.state === "reserved") return "starting";
  return peer.running ? "running" : "idle";
}

export function statuses(view: SwarmView, now: number): Map<string, Status> {
  const isExpired = expired(view, now);
  const byId = new Map(view.peers.map((peer) => [peer.id, peer]));
  const result = new Map<string, Status>();
  const resolve = (peer: SwarmPeer, seen = new Set<string>()): Status => {
    const known = result.get(peer.id);
    if (known) return known;
    const parent = peer.parentId && !seen.has(peer.parentId) ? byId.get(peer.parentId) : undefined;
    const inherited = parent ? resolve(parent, seen.add(peer.id)) : "idle";
    const status = effective(peer, inherited, isExpired);
    result.set(peer.id, status);
    return status;
  };
  for (const peer of view.peers) resolve(peer);
  return result;
}

export function summary(view: SwarmView, status: Map<string, Status>): string {
  const counts = new Map<Status, number>();
  for (const peer of view.peers)
    if (peer.depth > 0) {
      const key = status.get(peer.id) ?? "idle";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  return ORDER.filter((key) => counts.get(key))
    .map((key) => `${counts.get(key)} ${key}`)
    .join(" · ");
}

export function needsRefresh(view: SwarmView, status: Map<string, Status>): boolean {
  return view.peers.some(
    (peer) => peer.id !== view.id && !["paused", "stopped", "failed"].includes(status.get(peer.id) ?? "idle"),
  );
}
