import { isSessionTurn } from "../core/turn-origin.ts";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import type { RunStore } from "../runs/run-store.ts";
import type { Session, TurnOrigin } from "../types.ts";
import type { SessionStore } from "./session-store.ts";
import { isSubagentThreadRef, sessionAncestors } from "./session-syscalls.ts";

export async function delegatedAuthorizationOrigin(
  request: OrchestratorInput,
  deps: { runs: Pick<RunStore, "get">; sessions: Pick<SessionStore, "get" | "getByThread" | "getForParticipant"> },
): Promise<OrchestratorInput["origin"] | undefined> {
  if (
    request.origin.kind === "automation" ||
    request.readOnly ||
    request.privateSessionMessage ||
    request.swarm ||
    !request.delegatingRunId ||
    !request.sessionSenderId
  )
    return;
  const source = await deps.runs.get(request.delegatingRunId);
  if (!source)
    console.warn(
      `[authority] delegating run ${request.delegatingRunId} of ${request.conversation.threadRef} is gone; no inherited authority`,
    );
  const sender = await deps.sessions.getForParticipant(request.sessionSenderId, request.actor.id);
  const child = await deps.sessions.getByThread(request.conversation.threadRef);
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
    request.surface === "web" &&
    !child.parentSessionId &&
    !isSubagentThreadRef(child.threadRef) &&
    source.sessionId === sender.threadRef;
  if (!delegated && !continued && !started) return;
  const parent = source.request;
  if (!authorityReaches(parent, request, sender, child)) return;
  if (!isSessionTurn(parent)) return humanAuthored(parent) ? parent.origin : undefined;
  if (!delegated && !continued) return;
  const claim = request.delegatedAuthority;
  if (!claim || claim.kind !== request.origin.kind) return;
  if (!(await treeIntact(deps.sessions, delegated ? child : sender))) return;
  const granted = { conversation: parent.conversation, origin: claim };
  return humanAuthored(granted) ? claim : undefined;
}

async function treeIntact(sessions: Pick<SessionStore, "get">, subagent: Session): Promise<boolean> {
  const chain = [subagent, ...(await sessionAncestors(sessions, subagent))];
  return (
    !isSubagentThreadRef(chain.at(-1)!.threadRef) && chain.every((session) => session.scopeId === subagent.scopeId)
  );
}

export function heldAuthority(
  request: OrchestratorInput,
  delegatedOrigin: TurnOrigin | undefined,
): TurnOrigin | undefined {
  if (isSessionTurn(request)) return delegatedOrigin;
  return humanAuthored(request) ? request.origin : undefined;
}

function authorityReaches(
  parent: Pick<OrchestratorInput, "actor" | "conversation" | "readOnly" | "privateSessionMessage" | "swarm">,
  request: OrchestratorInput,
  sender: Session,
  child: Session,
): boolean {
  const audience = new Set([parent.actor.id, ...parent.conversation.audience.map((person) => person.id)]);
  return !(
    parent.actor.id !== request.actor.id ||
    parent.actor.type !== "internal" ||
    parent.readOnly ||
    parent.privateSessionMessage ||
    parent.swarm ||
    sender.scopeId !== child.scopeId ||
    child.scopeId !== conversationScope(parent.conversation, parent.actor.id) ||
    child.scopeId !== conversationScope(request.conversation, request.actor.id) ||
    request.conversation.audience.some((person) => !audience.has(person.id))
  );
}

function humanAuthored(parent: Pick<OrchestratorInput, "conversation" | "origin">): boolean {
  const internal =
    parent.conversation.audience.every((person) => person.type === "internal") &&
    (parent.conversation.kind === "dm" ||
      (!!parent.conversation.publishMembers?.length &&
        parent.conversation.publishMembers.every((person) => person.type === "internal")));
  return (
    internal &&
    (parent.origin.kind === "human" ||
      (parent.origin.kind === "ambient" && parent.origin.live === true && parent.conversation.kind !== "dm"))
  );
}
