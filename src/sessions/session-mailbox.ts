import type { DurableMap } from "../persistence/durable-map.ts";
import type { ClaimedRow } from "../tenants/claim.ts";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";

export const PEER_TASK_BANNER =
  "Task handed to you by another conversation (see from/fromSessionId below). Decide whether to do it now, after your current task, or not at all; if you defer or decline it, tell the sender with sessions send_message and wake:false:";
export interface SessionMessage {
  id: string;
  recipientId: string;
  senderId: string;
  actor: OrchestratorInput["actor"];
  botActor?: boolean;
  text: string;
  sourceEntrySeq?: number;
  audience: OrchestratorInput["conversation"]["audience"];
  createdAt: number;
  consumed?: boolean;
  wake?: true;
  senderRunId?: string;
  resultOf?: string;
  delegatingRunId?: string;
  peerDepth?: number;
}

export function createSessionMailbox(backing: DurableMap<SessionMessage>) {
  return {
    async send(message: SessionMessage): Promise<void> {
      await backing.putIfAbsent(message.id, message);
    },
    async pending(...recipientIds: string[]): Promise<SessionMessage[]> {
      const rows = await backing.select({ where: { field: "recipientId", anyOfFold: recipientIds } });
      return rows.filter((row) => !row.consumed).sort((a, b) => a.createdAt - b.createdAt);
    },
    async unread(recipientId: string, id: string): Promise<boolean> {
      const row = await backing.get(id);
      return row?.recipientId === recipientId && !row.consumed;
    },
    async wakesFor(...recipientIds: string[]): Promise<SessionMessage[]> {
      const recipients = new Set(recipientIds);
      const rows = await backing.select({ where: { field: "wake", anyOfFold: ["true"] } });
      return rows
        .filter((row) => recipients.has(row.recipientId) && !row.consumed)
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async claimWakeTenants(): Promise<ClaimedRow[]> {
      return backing.claimTenantsWhere("wake", "true");
    },
    async awaitingWake(afterId?: string): Promise<SessionMessage[]> {
      return backing.select({ where: { field: "wake", anyOfFold: ["true"] }, limit: 100, afterId });
    },
    async settle(recipientId: string, id: string): Promise<void> {
      const row = await backing.get(id);
      if (row?.recipientId === recipientId) await backing.merge(id, { wake: undefined });
    },
    async acknowledge(recipientId: string, ids: string[]): Promise<void> {
      for (const id of ids) {
        const row = await backing.get(id);
        if (row?.recipientId === recipientId) await backing.merge(id, { consumed: true, wake: undefined });
      }
    },
  };
}

export type SessionMailbox = ReturnType<typeof createSessionMailbox>;
