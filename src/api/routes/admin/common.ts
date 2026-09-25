import type { App } from "../../app.ts";
import type { ServerDeps } from "../../deps.ts";
import { parseScopeId, scopeId as makeScopeId, type Principal } from "../../../types.ts";
import { sendJson } from "../../http.ts";
import { orgScope, requireScopedAdmin } from "../shared.ts";
import { type ApiCtx } from "../route.ts";

export async function requireScopedResource<T>(
  ctx: ApiCtx,
  load: () => Promise<T | null | undefined> | T | null | undefined,
  scopeOf: (record: T) => string,
  noun: string,
  scopeMismatch: "forbid" | "fallback" = "forbid",
): Promise<{ actor: Principal; scope: string; record: T } | null> {
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return null;
  const record = await load();
  if (!record) {
    sendJson(ctx.res, 404, { error: "not_found" });
    return null;
  }
  if (parseScopeId(authz.scope).kind !== "org" && scopeOf(record) !== authz.scope) {
    if (scopeMismatch === "forbid") {
      sendJson(ctx.res, 403, { error: "forbidden", message: `${noun} is outside the requested scope` });
      return null;
    }
    return { actor: authz.actor, scope: scopeOf(record), record };
  }
  return { ...authz, record };
}

export const FILES_PAGE_SIZE = 200;

export async function discoverScopes(
  app: App,
  deps: ServerDeps,
  extraScopeIds: Iterable<string> = [],
): Promise<Map<string, string>> {
  const labels = new Map<string, string>([[orgScope(deps), "org-wide"]]);
  const [scopes, participants, grants] = await Promise.all([
    deps.sessions?.distinctScopes() ?? [],
    deps.sessions?.distinctParticipants() ?? [],
    deps.admin?.listGrants() ?? [],
  ]);
  for (const s of scopes) {
    if (!labels.has(s.scopeId) || (s.channelName && !labels.get(s.scopeId))) {
      labels.set(s.scopeId, s.channelName ? `#${s.channelName}` : "");
    }
  }
  const people = [...participants, ...grants.map((g) => g.principalId)];
  for (const principalId of people) {
    const personal = makeScopeId("personal", principalId);
    if (!labels.has(personal)) labels.set(personal, "");
  }
  for (const id of extraScopeIds) {
    if (!labels.has(id)) labels.set(id, "");
  }
  if ([...labels.values()].some((l) => !l)) {
    const [members, channels] = await Promise.all([app.directoryMembers(), app.directoryChannels()]);
    const membersById = new Map(members.map((m) => [m.principalId, m.displayName]));
    const channelsById = new Map(channels.map((c) => [c.channelId, c.name]));
    for (const [id, label] of labels) {
      if (label) continue;
      const { kind, ref } = parseScopeId(id);
      if (kind === "personal" && ref) {
        labels.set(id, membersById.get(ref) ?? "");
      } else if (kind === "channel" && ref) {
        const name = channelsById.get(ref);
        if (name) labels.set(id, `#${name}`);
      }
    }
  }
  return labels;
}
