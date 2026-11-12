import type { Principal, TurnRequest } from "../types.ts";
import { scopeId } from "../types.ts";
import { orgId as orgIdOf } from "../config.ts";
import { personIds } from "../directory/person.ts";
import { rosterAdmits } from "../resolution/scope-membership.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import { isSubagentThreadRef } from "../sessions/session-syscalls.ts";
import { isProjectGroupRef, projectIdFromGroupRef } from "../projects/project-store.ts";
import type { AppDeps } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";

interface ProjectAccess {
  audience: Principal[];
  name: string;
  version: string;
  memberIds: string[];
}

export type WriteAccess = { ok: true; project?: ProjectAccess } | { ok: false; reason: string };

const NOT_A_MEMBER: WriteAccess = { ok: false, reason: "you're not a member of that context" };

async function projectAccess(deps: AppDeps, ref: string, actor: Principal): Promise<WriteAccess> {
  const id = projectIdFromGroupRef(ref);
  if (!id) return NOT_A_MEMBER;
  const project = await deps.projects?.get(id);
  if (!project || project.orgId !== orgIdOf() || !deps.identity.isInternal(deps.identity.classify(project.ownerId)))
    return NOT_A_MEMBER;
  const roster = (await deps.projects?.members(ref)) ?? [];
  const memberIds = roster.filter((memberId) => deps.identity.isInternal(deps.identity.classify(memberId)));
  if (!rosterAdmits(memberIds, actor.id, scopeId("group", ref))) return NOT_A_MEMBER;
  const audience = await Promise.all(
    memberIds.map(async (memberId) => {
      if (memberId === actor.id) return actor;
      const principal = deps.identity.classify(memberId);
      const member = await deps.directory.get(memberId).catch(() => null);
      return member?.displayName ? { ...principal, displayName: member.displayName } : principal;
    }),
  );
  return { ok: true, project: { audience, name: project.name, version: String(project.updatedAt), memberIds } };
}

export async function conversationWriteAccess(
  deps: AppDeps,
  h: AppHelpers,
  req: TurnRequest,
  actor: Principal,
): Promise<WriteAccess> {
  const ref = req.conversation.channelRef;
  let access: WriteAccess = { ok: true };
  if (req.conversation.kind === "group" && ref && isProjectGroupRef(ref)) {
    access = await projectAccess(deps, ref, actor);
  } else if (req.surface === "web" && req.conversation.kind !== "dm") {
    if (!ref || !(await h.mayUseSharedScope(req.conversation.kind, ref, actor))) return NOT_A_MEMBER;
  }
  if (!access.ok) return access;
  const claimed = conversationScope(req.conversation, actor.id);
  if (isSubagentThreadRef(req.conversation.threadRef)) {
    const target = await deps.sessions.getByThread(req.conversation.threadRef);
    if (
      !target?.spawnMeta ||
      target.scopeId !== claimed ||
      !(await deps.sessions.getForParticipant(target.id, actor.id)) ||
      !(await h.principalCanWriteScope(actor.id, target.scopeId))
    )
      return { ok: false, reason: "you cannot continue that subagent session" };
  }
  if (req.surface !== "web") return access;
  const threadRef = req.conversation.threadRef;
  const existing = await deps.sessions.getByThread(threadRef);
  if (existing) {
    if (existing.scopeId !== claimed) return { ok: false, reason: "that conversation lives in a different context" };
    if (!(await h.mayWriteSession(actor.id, existing)))
      return { ok: false, reason: "you can't continue that conversation from the web" };
  } else if (threadRef.startsWith("web:") && !personIds(actor.id).some((id) => threadRef.startsWith(`web:${id}:`))) {
    return { ok: false, reason: "you can only start a new conversation on your own thread" };
  }
  return access;
}
