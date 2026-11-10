import { isPrincipalType, PRINCIPAL_TYPES } from "../../types.ts";
import type { DirectoryMember } from "../../directory/directory-store.ts";
import { canonicalPerson } from "../../directory/person.ts";
import { cleanDisplayName } from "../../identity/user-store.ts";
import { personLabel } from "../../identity/person-names.ts";
import { sendJson } from "../http.ts";
import { audit, isObj, orgScope } from "./shared.ts";
import { withActor, type ApiCtx, type Route } from "./route.ts";
import { trimTrailingSlashes } from "../../util/text.ts";
import { reactivatePerson } from "./admin/offboard.ts";

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
  await reactivatePerson(deps, id);
  audit(deps, { principalId: id, action: "principal.reactivate", resource: "principal", scopeLabel: orgScope(deps) });
  return sendJson(res, 200, { ok: true, principalId: id, active: true });
}

async function canonicalPrincipal(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const id = ctx.params.id!;
  if (!id) return sendJson(res, 404, { error: "not_found" });
  await deps.identity?.refresh();
  const canonicalId = canonicalPerson(id);
  const user = await deps.users?.get(canonicalId);
  const label = personLabel(canonicalId, { user });
  return sendJson(res, 200, {
    principalId: id,
    canonicalId,
    ...(label !== canonicalId ? { displayName: label } : {}),
    ...(user?.displayName ? { storedName: user.displayName } : {}),
  });
}

async function recordProfile(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!deps.users) return sendJson(res, 404, { error: "not_found" });
  const b = isObj(ctx.body) ? ctx.body : {};
  const principalId = typeof b.principalId === "string" ? b.principalId.trim() : "";
  const displayName = cleanDisplayName(b.displayName);
  if (!principalId || !displayName)
    return sendJson(res, 400, { error: "bad_request", message: "principalId and displayName required" });
  const changed = await deps.users.setDisplayName(canonicalPerson(principalId), displayName);
  return sendJson(res, 200, { ok: true, changed });
}

async function pushDirectory(ctx: ApiCtx): Promise<void> {
  const { res, app, body } = ctx;
  const b = body as {
    members?: unknown;
    channels?: unknown;
    channelMembers?: unknown;
    channelRosterIds?: unknown;
    channelRevocations?: unknown;
    groupMembers?: unknown;
    groupIds?: unknown;
    groupRosterIds?: unknown;
    workspaceUrl?: unknown;
    membersSyncedAt?: unknown;
    channelsSyncedAt?: unknown;
    partialChannels?: unknown;
    groupsSyncedAt?: unknown;
  };
  if (!Array.isArray(b.members) && !Array.isArray(b.channels) && !Array.isArray(b.groupMembers)) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "members[], channels[], and/or groupMembers[] required",
    });
  }
  if (
    b.partialChannels !== undefined &&
    (typeof b.partialChannels !== "boolean" ||
      (b.partialChannels &&
        (!Array.isArray(b.channels) ||
          !Array.isArray(b.channelMembers) ||
          numOrUndef(b.channelsSyncedAt) === undefined)))
  ) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "partial channels require channels[], channelMembers[] and channelsSyncedAt",
    });
  }
  if (Array.isArray(b.members) && b.members.some((m) => isObj(m) && !isPrincipalType(m.type))) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: `member type must be one of: ${PRINCIPAL_TYPES.join(", ")}`,
    });
  }
  const workspaceUrl = typeof b.workspaceUrl === "string" ? trimTrailingSlashes(b.workspaceUrl) : "";
  if (/^https:\/\/[^\s/]+$/.test(workspaceUrl)) await app.setDirectoryWorkspaceUrl(workspaceUrl);
  let memberCount: number | undefined;
  if (Array.isArray(b.members)) {
    const members = b.members
      .filter(
        (m): m is DirectoryMember =>
          isObj(m) && typeof m.principalId === "string" && typeof m.displayName === "string" && isPrincipalType(m.type),
      )
      .map((m) => ({
        principalId: m.principalId,
        displayName: m.displayName,
        type: m.type,
        ...(typeof m.slackId === "string" && m.slackId ? { slackId: m.slackId } : {}),
        ...(typeof m.avatarUrl === "string" && m.avatarUrl.startsWith("https://") ? { avatarUrl: m.avatarUrl } : {}),
        ...(m.isBot === true ? { isBot: true } : {}),
      }));
    await app.upsertDirectory(members, numOrUndef(b.membersSyncedAt));
    memberCount = members.length;
  }
  let channelCount: number | undefined;
  if (Array.isArray(b.channels)) {
    const channels = b.channels.filter(
      (c): c is { channelId: string; name: string; isPrivate?: boolean; isExternal?: boolean } =>
        isObj(c) && typeof c.channelId === "string" && typeof c.name === "string",
    );
    const channelMembers = Array.isArray(b.channelMembers)
      ? b.channelMembers.filter(
          (m): m is { channelId: string; principalId: string } =>
            isObj(m) && typeof m.channelId === "string" && typeof m.principalId === "string",
        )
      : undefined;
    const channelRosterIds = Array.isArray(b.channelRosterIds)
      ? b.channelRosterIds.filter((channelId): channelId is string => typeof channelId === "string")
      : undefined;
    const channelRevocations = Array.isArray(b.channelRevocations)
      ? b.channelRevocations.filter(
          (m): m is { channelId: string; principalId: string } =>
            isObj(m) && typeof m.channelId === "string" && typeof m.principalId === "string",
        )
      : undefined;
    const applied = await app.upsertChannels(
      channels,
      channelMembers,
      numOrUndef(b.channelsSyncedAt),
      channelRosterIds,
      channelRevocations,
      b.partialChannels === true,
    );
    if (b.partialChannels && !applied) return sendJson(res, 409, { error: "stale_directory_observation" });
    channelCount = channels.length;
  }
  let groupMemberCount: number | undefined;
  if (Array.isArray(b.groupMembers)) {
    const groupMembers = b.groupMembers.filter(
      (m): m is { groupId: string; principalId: string } =>
        isObj(m) && typeof m.groupId === "string" && typeof m.principalId === "string",
    );
    const groupIds = Array.isArray(b.groupIds)
      ? b.groupIds.filter((groupId): groupId is string => typeof groupId === "string")
      : undefined;
    const groupRosterIds = Array.isArray(b.groupRosterIds)
      ? b.groupRosterIds.filter((groupId): groupId is string => typeof groupId === "string")
      : undefined;
    await app.upsertGroups(groupMembers, numOrUndef(b.groupsSyncedAt), groupIds, groupRosterIds);
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
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
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

async function channelsFor(ctx: ApiCtx): Promise<void> {
  const principalId = (ctx.url.searchParams.get("principalId") ?? "").trim();
  if (!principalId) return sendJson(ctx.res, 400, { error: "bad_request", message: "principalId required" });
  const typed = (ctx.url.searchParams.get("q") ?? "").trim().toLowerCase();
  const term = typed.startsWith("#") ? typed.slice(1) : typed;
  const rank = (name: string) => {
    const lower = name.toLowerCase();
    if (lower === term) return 0;
    return lower.startsWith(term) ? 1 : 2;
  };
  const channels = (await ctx.app.directoryChannelsFor(principalId))
    .filter((channel) => channel.name.toLowerCase().includes(term))
    .sort((a, b) => rank(a.name) - rank(b.name) || Number(a.name > b.name) - Number(a.name < b.name))
    .map((channel) => ({
      scopeId: `channel:${channel.channelId}`,
      channelId: channel.channelId,
      name: channel.name,
      isPrivate: channel.isPrivate === true,
    }));
  return sendJson(ctx.res, 200, { channels });
}

async function channelMembership(ctx: ApiCtx): Promise<void> {
  return sendJson(ctx.res, 200, {
    member: await ctx.app.channelMember(ctx.params.channelId!, ctx.params.principalId!),
  });
}

export const directoryRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/principals/:id/canonical", auth: "source", handle: canonicalPrincipal },
  { method: "POST", path: "/v1/principals/profile", actor: "body.principalId", auth: "source", handle: recordProfile },
  { method: "GET", path: "/v1/directory/meta", auth: "source", handle: directoryMeta },
  {
    method: "GET",
    path: "/v1/directory/channels",
    browser: true,
    actor: "query.principalId",
    auth: "source",
    handle: channelsFor,
  },
  {
    method: "GET",
    path: "/v1/directory/channels/:channelId/members/:principalId",
    actor: "system",
    auth: "source",
    handle: channelMembership,
  },
  {
    method: "GET",
    path: "/v1/directory/resolve",
    browser: true,
    actor: "person",
    auth: "either",
    handle: resolveDirectory,
  },
  ...withActor("system", [
    { method: "POST", path: "/v1/principals/:id/deactivate", auth: "source", handle: deactivatePrincipal },
    { method: "POST", path: "/v1/principals/:id/reactivate", auth: "source", handle: reactivatePrincipal },
    { method: "POST", path: "/v1/directory", auth: "source", handle: pushDirectory },
  ]),
];
