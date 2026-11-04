import type { DurableMap } from "../persistence/durable-map.ts";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";

export interface SessionMessage {
  id: string;
  recipientId: string;
  senderId: string;
  actor: OrchestratorInput["actor"];
  text: string;
  sourceEntrySeq?: number;
  audience: OrchestratorInput["conversation"]["audience"];
  createdAt: number;
  consumed?: boolean;
  wake?: true;
  senderRunId?: string;
  resultOf?: string;
  delegatingRunId?: string;
}

export function createSessionMailbox(backing: DurableMap<SessionMessage>) {
  return {
    async send(message: SessionMessage): Promise<void> {
      await backing.putIfAbsent(message.id, message);
    },
    async pending(recipientId: string): Promise<SessionMessage[]> {
      const rows = await backing.select({ where: { field: "recipientId", anyOfFold: [recipientId] } });
      return rows.filter((row) => !row.consumed).sort((a, b) => a.createdAt - b.createdAt);
    },
    async unread(recipientId: string, id: string): Promise<boolean> {
      const row = await backing.get(id);
      return row?.recipientId === recipientId && !row.consumed;
    },
    async wakesFor(recipientId: string): Promise<SessionMessage[]> {
      const rows = await backing.select({ where: { field: "wake", anyOfFold: ["true"] } });
      return rows
        .filter((row) => row.recipientId === recipientId && !row.consumed)
        .sort((a, b) => a.createdAt - b.createdAt);
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
