import type { App } from "../../app.ts";
import type { ServerDeps } from "../../deps.ts";
import { parseScopeId, scopeId as makeScopeId, type Principal } from "../../../types.ts";
import type { Tenant } from "../../../tenants/context.ts";
import { foldPrincipalId, personIds } from "../../../directory/person.ts";
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

export async function personNamer(app: App, deps: ServerDeps): Promise<(principalId: string) => string | undefined> {
  const [members] = await Promise.all([app.directoryMembers(), deps.identity?.refresh()]);
  const byId = new Map(members.map((m) => [foldPrincipalId(m.principalId), m.displayName?.trim() || m.principalId]));
  return (principalId) => {
    const ids = [principalId, ...personIds(principalId)];
    return ids.map((id) => byId.get(foldPrincipalId(id))).find(Boolean) ?? ids.find((id) => id.includes("@"));
  };
}

export function threadRefLabel(
  resource: string | undefined,
  nameOf: (principalId: string) => string | undefined,
): string | undefined {
  const start = resource?.indexOf(":") ?? -1;
  const end = resource?.lastIndexOf(":") ?? -1;
  if (!resource || start < 1 || end <= start + 1 || end === resource.length - 1) return undefined;
  const principalId = resource.slice(start + 1, end);
  const owner = nameOf(principalId);
  return owner && owner !== principalId ? `${resource.slice(0, start)}:${owner}${resource.slice(end)}` : undefined;
}

export async function discoverScopes(
  app: App,
  deps: ServerDeps,
  tenant: Tenant,
  extraScopeIds: Iterable<string> = [],
): Promise<Map<string, string>> {
  const labels = new Map<string, string>([[orgScope(deps), "org-wide"]]);
  const [scopes, participants, grants] = await Promise.all([
    deps.sessions?.distinctScopes() ?? [],
    deps.sessions?.distinctParticipants() ?? [],
    deps.admin?.listGrants(tenant) ?? [],
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
    const [nameOf, channels] = await Promise.all([personNamer(app, deps), app.directoryChannels()]);
    const channelsById = new Map(channels.map((c) => [c.channelId, c.name]));
    for (const [id, label] of labels) {
      if (label) continue;
      const { kind, ref } = parseScopeId(id);
      if (kind === "personal" && ref) {
        labels.set(id, nameOf(ref) ?? "");
      } else if (kind === "channel" && ref) {
        const name = channelsById.get(ref);
        if (name) labels.set(id, `#${name}`);
      }
    }
  }
  return distinctPersonalLabels(labels);
}

function distinctPersonalLabels(labels: Map<string, string>): Map<string, string> {
  const personal = [...labels].filter(([id, label]) => label && parseScopeId(id).kind === "personal");
  const uses = new Map<string, number>();
  for (const [, label] of personal) uses.set(label, (uses.get(label) ?? 0) + 1);
  for (const [id, label] of personal) {
    if ((uses.get(label) ?? 0) < 2) continue;
    labels.set(id, `${label} (${parseScopeId(id).ref.includes("@") ? "by email" : "by sign-in"})`);
  }
  return labels;
}
