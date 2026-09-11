import { assertSpawnLease, createSpawnLease } from "./spawn-lease.ts";
import { swallow } from "../util/errors.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import { parseScopeId } from "../types.ts";
import type { SandboxResources } from "../sandbox/sandbox-resources.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { PeerBoard } from "./board.ts";
import type { PeerDispatcher } from "./dispatcher.ts";
import type { CoordinationRepository } from "./repository.ts";
import { CoordinationError, type Peer, type PeerAuthority, type PeerSpawn } from "./types.ts";

export function createPeerSpawnWorker(deps: {
  repository: CoordinationRepository;
  sessions: SessionStore;
  resources: Pick<SandboxResources, "create">;
  board: Pick<PeerBoard, "publish">;
  dispatcher: Pick<PeerDispatcher, "dispatch">;
  authorize(peer: Peer): Promise<PeerAuthority | null>;
  participants(peer: Peer): Promise<string[]>;
}) {
  const leases = createSpawnLease(deps.repository);
  async function activeAuthority(spawn: PeerSpawn): Promise<PeerAuthority> {
    const parent = await deps.repository.get("peer", spawn.parentId);
    if (!parent || parent.state !== "active" || !(await deps.sessions.get(parent.id)))
      throw new CoordinationError(409, "spawn_parent_unavailable", "spawn parent is unavailable");
    const authority = await deps.authorize(parent);
    if (!authority) throw new CoordinationError(403, "execution_authority_revoked", "spawn authority is unavailable");
    if (conversationScope(authority.conversation, authority.actor.id) !== parent.scopeId)
      throw new CoordinationError(409, "spawn_scope_changed", "parent authority no longer matches its scope");
    return authority;
  }
  async function advance(id: string): Promise<PeerSpawn> {
    const spawn = await leases.claim(id);
    if (!spawn) return (await deps.repository.get("spawn", id))!;
    const token = spawn.leaseToken!;
    const save = (change: Partial<PeerSpawn>) => leases.save(id, token, change);
    try {
      const authority = await activeAuthority(spawn);
      const child = await deps.repository.get("peer", spawn.childId);
      if (!child || child.state !== "active" || child.parentId !== spawn.parentId || child.rootId !== spawn.rootId)
        throw new CoordinationError(409, "spawn_child_unavailable", "reserved child is unavailable");
      await save({ state: "provisioning", reason: null });
      const threadRef = `web:${authority.actor.id}:${child.id}`;
      const session = await deps.sessions.getOrCreateByThread(
        threadRef,
        authority.conversation.kind,
        child.scopeId,
        undefined,
        "web",
        child.id,
      );
      if (!session.title) await deps.sessions.updateTitle(child.id, spawn.initialName);
      const participants = new Set([authority.actor.id, ...(await deps.participants(child))]);
      for (const participant of participants) await deps.sessions.addParticipant(child.id, participant);
      const resource = await deps.resources.create(
        authority.actor.id,
        child.scopeId,
        spawn.backend,
        spawn.initialName,
        child.id,
      );
      const currentAuthority = await activeAuthority(spawn);
      if (currentAuthority.actor.id !== authority.actor.id)
        throw new CoordinationError(403, "execution_authority_revoked", "spawn owner changed");
      const conversation = {
        ...currentAuthority.conversation,
        threadRef,
        ...(currentAuthority.conversation.kind !== "dm" ? { channelRef: parseScopeId(child.scopeId).ref } : {}),
      };
      if (conversationScope(conversation, currentAuthority.actor.id) !== child.scopeId)
        throw new CoordinationError(409, "spawn_scope_changed", "child authority does not match its reserved scope");
      const bind = () =>
        deps.repository.transaction([`tree:${spawn.rootId}`, `peer:${child.id}`, `spawn:${id}`], async (tx) => {
          const operation = await tx.get("spawn", id);
          assertSpawnLease(operation, token);
          for (const sessionId of [spawn.parentId, child.id].sort()) {
            const exists = tx.sessionExists
              ? await tx.sessionExists(sessionId)
              : !!(await deps.sessions.get(sessionId));
            if (!exists) throw new CoordinationError(409, "spawn_session_unavailable", "spawn session was deleted");
          }
          const current = await tx.get("peer", child.id);
          const parent = await tx.get("peer", spawn.parentId);
          if (!current || current.state !== "active" || parent?.state !== "active")
            throw new CoordinationError(409, "spawn_child_unavailable", "reserved child is unavailable");
          const now = Date.now();
          await tx.put("peer", {
            ...current,
            sandboxId: resource.id,
            authority: {
              ...currentAuthority,
              surface: "web",
              conversation,
            },
            updatedAt: now,
          });
          await tx.put("spawn", { ...operation, sandboxId: resource.id, updatedAt: now });
          await tx.event("peer", child.id, now);
          await tx.event("spawn", id, now);
        });
      if (deps.sessions.withSessionLocks) await deps.sessions.withSessionLocks([spawn.parentId, child.id], bind);
      else await bind();
      const message = await deps.board.publish({
        senderId: spawn.parentId,
        senderRunId: spawn.parentRunId,
        idempotencyKey: `spawn:${id}`,
        text: spawn.task,
        audience: `.[] | select(._qm.id == ${JSON.stringify(child.id)})`,
      });
      const deliveryId = `${message.id}:${child.id}`;
      await deps.dispatcher.dispatch(deliveryId);
      const delivery = await deps.repository.get("delivery", deliveryId);
      if (!delivery?.runId)
        throw new CoordinationError(409, "spawn_dispatch_pending", "initial task is awaiting admission");
      return save({ state: "ready", runId: delivery.runId, reason: null });
    } catch (error) {
      if (!(error instanceof CoordinationError && error.code === "spawn_lease_lost"))
        await save({
          state: "failed",
          reason: error instanceof CoordinationError ? error.code : "spawn_provisioning_failed",
        });
      throw error;
    }
  }
  return {
    advance,
    async sweep(): Promise<void> {
      const pending = await deps.repository.pendingSpawns(Date.now(), 20);
      for (const spawn of pending) {
        try {
          await advance(spawn.id);
        } catch (error) {
          swallow("peer spawn recovery", error);
        }
      }
    },
  };
}

export type PeerSpawnWorker = ReturnType<typeof createPeerSpawnWorker>;
