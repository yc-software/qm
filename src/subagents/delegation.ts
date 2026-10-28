import { surfaceHas } from "../surfaces/surface.ts";
import { isSessionTurn } from "../core/turn-origin.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";
import { type RunStore } from "../runs/run-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { isSubagentThreadRef } from "../sessions/thread-ref.ts";

export function requiresDelegation(
  request: Pick<OrchestratorInput, "surface" | "surfaceTools" | "conversation">,
  enabled: boolean,
): boolean {
  return (
    enabled &&
    !isSubagentThreadRef(request.conversation.threadRef) &&
    (surfaceHas(request.surface, "delegates") || request.surfaceTools === true)
  );
}

export async function delegatedAuthorizationOrigin(
  request: OrchestratorInput,
  deps: { runs: Pick<RunStore, "get">; sessions: Pick<SessionStore, "getByThread" | "getForParticipant"> },
): Promise<OrchestratorInput["origin"] | undefined> {
  const seen = new Set<string>();
  let current = request;
  for (let depth = 0; depth < 32; depth++) {
    const jobExit = current.surface === "monitor";
    if (
      (current.origin.kind === "automation" && !jobExit) ||
      current.readOnly ||
      current.privateSessionMessage ||
      !current.delegatingRunId ||
      (!current.sessionSenderId && !jobExit) ||
      seen.has(current.delegatingRunId)
    )
      return;
    seen.add(current.delegatingRunId);
    const source = await deps.runs.get(current.delegatingRunId);
    const child = await deps.sessions.getByThread(current.conversation.threadRef);
    const sender = jobExit ? child : await deps.sessions.getForParticipant(current.sessionSenderId!, request.actor.id);
    if (!source || !sender || !child) return;
    const delegated =
      isSubagentThreadRef(child.threadRef) &&
      child.parentSessionId === sender.id &&
      source.sessionId === sender.threadRef;
    const continued =
      isSubagentThreadRef(sender.threadRef) &&
      sender.parentSessionId === child.id &&
      source.sessionId === child.threadRef;
    const started =
      surfaceHas(current.surface, "sidebar") &&
      !child.parentSessionId &&
      !isSubagentThreadRef(child.threadRef) &&
      source.sessionId === sender.threadRef;
    const resumed = jobExit && source.sessionId === child.threadRef;
    if (!delegated && !continued && !started && !resumed) return;
    const parent = source.request;
    const audience = new Set([parent.actor.id, ...parent.conversation.audience.map((person) => person.id)]);
    if (
      parent.actor.id !== request.actor.id ||
      parent.actor.type !== "internal" ||
      parent.readOnly ||
      parent.privateSessionMessage ||
      sender.scopeId !== child.scopeId ||
      child.scopeId !== conversationScope(parent.conversation, parent.actor.id) ||
      child.scopeId !== conversationScope(current.conversation, current.actor.id) ||
      current.conversation.audience.some((person) => !audience.has(person.id))
    )
      return;
    const internal =
      parent.conversation.audience.every((person) => person.type === "internal") &&
      (parent.conversation.kind === "dm" ||
        (!!parent.conversation.publishMembers?.length &&
          parent.conversation.publishMembers.every((person) => person.type === "internal")));
    if (
      !isSessionTurn(parent) &&
      internal &&
      (parent.origin.kind === "human" ||
        (parent.origin.kind === "ambient" && parent.origin.live === true && parent.conversation.kind !== "dm"))
    )
      return parent.origin;
    current = parent;
  }
}
