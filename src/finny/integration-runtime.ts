import type { SessionStore } from "../sessions/session-store.ts";
import type { SessionSyscalls, SessionSyscallsFactory } from "../sessions/session-syscalls.ts";
import type { ScopeId } from "../types.ts";
import type { FinnyIntegrationParentRecord } from "./integration-postgres-store.ts";

export async function reconstructFinnyParentSyscalls(deps: {
  sessions: Pick<SessionStore, "get">;
  syscalls: SessionSyscallsFactory;
  parent: FinnyIntegrationParentRecord;
}): Promise<SessionSyscalls> {
  const session = await deps.sessions.get(deps.parent.binding.sessionId);
  if (!session || session.id !== deps.parent.binding.sessionId || session.scopeId !== deps.parent.scopeId)
    throw new Error("Finny parent session is unavailable");
  const context = deps.parent.binding.context;
  if (context.actor.type !== "internal" || context.actor.id !== deps.parent.actorId)
    throw new Error("Finny parent session actor does not match persisted authority");
  return deps.syscalls.forTurn({
    session,
    scopeId: deps.parent.scopeId as ScopeId,
    request: {
      ...context,
      deliveryTarget: deps.parent.destination.target,
      actor: context.actor,
      conversation: context.conversation,
      origin: { kind: "automation", destination: deps.parent.destination },
    },
  });
}
