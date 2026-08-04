import type { PrincipalType } from "../../types.ts";
import type { DirectoryMember } from "../../directory/directory-store.ts";
import { sendJson } from "../http.ts";
import { audit, isObj, orgScope } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";

const numOrUndef = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

async function deactivatePrincipal(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.identity) return sendJson(res, 404, { error: "not_found" });
  const id = ctx.params.id!;
  if (!id) return sendJson(res, 404, { error: "not_found" });
  await deps.identity.deactivate(id);
  audit(deps, { principalId: id, action: "principal.deactivate", resource: "principal", scopeLabel: orgScope(deps) });
  return sendJson(res, 200, { ok: true, principalId: id, active: false });
}

async function reactivatePrincipal(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.identity) return sendJson(res, 404, { error: "not_found" });
  const id = ctx.params.id!;
  if (!id) return sendJson(res, 404, { error: "not_found" });
  await deps.identity.reactivate(id);
  audit(deps, { principalId: id, action: "principal.reactivate", resource: "principal", scopeLabel: orgScope(deps) });
  return sendJson(res, 200, { ok: true, principalId: id, active: true });
}

async function pushDirectory(ctx: ApiCtx): Promise<void> {
  const { res, app, body } = ctx;
  const b = body as {
    members?: unknown;
    channels?: unknown;
    channelMembers?: unknown;
    groupMembers?: unknown;
    workspaceUrl?: unknown;
    membersSyncedAt?: unknown;
    channelsSyncedAt?: unknown;
    groupsSyncedAt?: unknown;
  };
  if (!Array.isArray(b.members) && !Array.isArray(b.channels) && !Array.isArray(b.groupMembers)) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "members[], channels[], and/or groupMembers[] required",
    });
  }
  if (typeof b.workspaceUrl === "string" && /^https:\/\/[^\s/]+$/.test(b.workspaceUrl.replace(/\/+$/, ""))) {
    await app.setDirectoryWorkspaceUrl(b.workspaceUrl.replace(/\/+$/, ""));
  }
  let memberCount: number | undefined;
  if (Array.isArray(b.members)) {
    const members = b.members
      .filter(
        (m): m is { principalId: string; displayName: string; type: PrincipalType; slackId?: string } =>
          isObj(m) &&
          typeof m.principalId === "string" &&
          typeof m.displayName === "string" &&
          typeof m.type === "string",
      )
      .map((m) => ({
        principalId: m.principalId,
        displayName: m.displayName,
        type: m.type,
        ...(typeof m.slackId === "string" && m.slackId ? { slackId: m.slackId } : {}),
      }));
    await app.upsertDirectory(members, numOrUndef(b.membersSyncedAt));
    memberCount = members.length;
  }
  let channelCount: number | undefined;
  if (Array.isArray(b.channels)) {
    const channels = b.channels.filter(
      (c): c is { channelId: string; name: string; isPrivate?: boolean } =>
        isObj(c) && typeof c.channelId === "string" && typeof c.name === "string",
    );
    const channelMembers = Array.isArray(b.channelMembers)
      ? b.channelMembers.filter(
          (m): m is { channelId: string; principalId: string } =>
            isObj(m) && typeof m.channelId === "string" && typeof m.principalId === "string",
        )
      : undefined;
    await app.upsertChannels(channels, channelMembers, numOrUndef(b.channelsSyncedAt));
    channelCount = channels.length;
  }
  let groupMemberCount: number | undefined;
  if (Array.isArray(b.groupMembers)) {
    const groupMembers = b.groupMembers.filter(
      (m): m is { groupId: string; principalId: string } =>
        isObj(m) && typeof m.groupId === "string" && typeof m.principalId === "string",
    );
    await app.upsertGroups(groupMembers, numOrUndef(b.groupsSyncedAt));
    groupMemberCount = groupMembers.length;
  }
  return sendJson(res, 200, {
    ok: true,
    ...(memberCount !== undefined ? { members: memberCount } : {}),
    ...(channelCount !== undefined ? { channels: channelCount } : {}),
    ...(groupMemberCount !== undefined ? { groupMembers: groupMemberCount } : {}),
  });
}

async function directoryMeta(ctx: ApiCtx): Promise<void> {
  const { res, app } = ctx;
  return sendJson(res, 200, await app.directoryMeta());
}

const SLACK_ID_RE = /^[UW][A-Z0-9]{8,}$/;
async function resolveDirectory(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return sendJson(res, 400, { error: "bad_request", message: "q (a name to resolve) required" });
  const r = await app.resolveRecipient(q);
  let found: DirectoryMember[] = [];
  if (r.kind === "one") found = [r.member];
  else if (r.kind === "ambiguous") found = r.candidates;
  const matches = found.map((m) => {
    const slackId = m.slackId ?? (SLACK_ID_RE.test(m.principalId) ? m.principalId : undefined);
    return slackId ? { ...m, slackId } : m;
  });
  return sendJson(res, 200, { matches });
}

export const directoryRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/principals/:id/deactivate", auth: "source", handle: deactivatePrincipal },
  { method: "POST", path: "/v1/principals/:id/reactivate", auth: "source", handle: reactivatePrincipal },
  { method: "POST", path: "/v1/directory", auth: "source", handle: pushDirectory },
  { method: "GET", path: "/v1/directory/meta", auth: "source", handle: directoryMeta },
  { method: "GET", path: "/v1/directory/resolve", auth: "either", handle: resolveDirectory },
];
