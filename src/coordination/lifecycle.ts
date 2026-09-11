import type { CoordinationRepository } from "./repository.ts";
import type { PeerSpawning } from "./spawning.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { RunStore } from "../runs/run-store.ts";
import type { RunSignalStore } from "../runs/run-signal-store.ts";

export function createPeerLifecycle(deps: {
  repository: CoordinationRepository;
  spawning: PeerSpawning;
  sessions: SessionStore;
  runs: RunStore;
  signals: RunSignalStore;
}) {
  let deletionCursor = "";
  async function reconcileDeleted(id: string): Promise<void> {
    const observed = await deps.repository.get("peer", id);
    if (!observed || observed.state === "deleted" || (await deps.sessions.get(id))) return;
    const wasDeleted = await deps.sessions.wasDeleted(id);
    await deps.repository.transaction([`tree:${observed.rootId}`, `peer:${id}`], async (tx) => {
      const peer = await tx.get("peer", id);
      if (!peer || peer.state === "deleted") return;
      const exists = tx.sessionExists ? await tx.sessionExists(id) : !!(await deps.sessions.get(id));
      if (exists) return;
      if (peer.parentId) {
        const spawn = (await tx.list("spawn", { childId: id }))[0];
        if ((!spawn || spawn.state !== "ready") && !wasDeleted) return;
      }
      const now = Date.now();
      await tx.put("peer", { ...peer, state: "deleted", authority: null, updatedAt: now });
      await tx.event("peer", id, now);
    });
  }
  async function reconcile(threadRef: string): Promise<void> {
    const session = await deps.sessions.getByThread(threadRef);
    if (!session) return;
    const peer = await deps.repository.get("peer", session.id);
    if (!peer || peer.state === "active") return;
    for (const run of await deps.runs.inFlightForThread(threadRef)) {
      await deps.signals.send(run.id, {
        kind: "abort",
        dedupeKey: `peer-lifecycle:${peer.id}:${peer.updatedAt}:${run.id}`,
      });
    }
  }
  return {
    reconcileDeleted,
    async canRun(threadRef: string): Promise<boolean> {
      const session = await deps.sessions.getByThread(threadRef);
      if (!session) return true;
      const peer = await deps.repository.get("peer", session.id);
      return !peer || (peer.state === "active" && (!peer.parentId || !!peer.sandboxId));
    },
    async transition(id: string, action: "pause" | "resume" | "stop", subtree = false) {
      const changed = await deps.spawning.transition(id, action, subtree);
      for (const peer of changed) {
        const session = await deps.sessions.get(peer.id);
        if (session) await reconcile(session.threadRef);
      }
      return changed;
    },
    async sweep(): Promise<void> {
      for (const thread of await deps.runs.activeSessionIds()) await reconcile(thread);
      const ids = await deps.repository.livePeerIds(deletionCursor, 100);
      for (const id of ids) {
        await reconcileDeleted(id);
        deletionCursor = id;
      }
      if (ids.length < 100) deletionCursor = "";
    },
  };
}

export type PeerLifecycle = ReturnType<typeof createPeerLifecycle>;
