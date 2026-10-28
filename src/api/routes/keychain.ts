import {
  connectorHandle,
  credentialHandle,
  KeychainError,
  renderAskNotice,
  type CredentialFieldInput,
  type CredentialFile,
  type GrantMode,
} from "../../credentials/keychain.ts";
import { parseScopeId } from "../../types.ts";
import { samePerson } from "../../directory/person.ts";
import { approvalCardDestination } from "../../credentials/keychain-approval.ts";
import { sendJson } from "../http.ts";
import { normalizeInboundExpiresAt } from "../expiry.ts";
import type { ApiCtx, Route } from "./route.ts";
import type { CapabilityClaims } from "../../auth/capability-token.ts";
import { audit, resolveCapabilityDestination } from "./shared.ts";
import { swallowAs } from "../../util/errors.ts";
import { cronIdOf } from "../../sessions/session-store.ts";
import { connectorHostLabel } from "../../connectors/oauth.ts";
import type { DirectoryMember } from "../../directory/directory-store.ts";

async function resolveScopeNames(
  app: ApiCtx["app"],
  deps: ApiCtx["deps"],
  scopeIds: Iterable<string>,
): Promise<Record<string, string>> {
  const wanted = [...new Set(scopeIds)];
  if (!wanted.length) return {};
  const names: Record<string, string> = {};
  const sessionScopes =
    (await Promise.resolve(deps.sessions?.distinctScopes()).catch(swallowAs("keychain scope names: sessions", null))) ??
    [];
  const byScope = new Map(sessionScopes.filter((s) => s.channelName).map((s) => [s.scopeId, s.channelName!]));
  let channelsById: Map<string, string> | null = null;
  let membersById: Map<string, string> | null = null;
  for (const id of wanted) {
    const { kind, ref } = parseScopeId(id);
    const fromSessions = byScope.get(id);
    if (kind === "channel" && ref) {
      if (fromSessions) {
        names[id] = `#${fromSessions.replace(/^#/, "")}`;
        continue;
      }
      channelsById ??= new Map(
        (await app.directoryChannels().catch(swallowAs("keychain scope names: channels", []))).map((c) => [
          c.channelId,
          c.name,
        ]),
      );
      const name = channelsById.get(ref);
      if (name) names[id] = `#${name.replace(/^#/, "")}`;
    } else if (kind === "personal" && ref) {
      membersById ??= new Map(
        (await app.directoryMembers().catch(swallowAs("keychain scope names: members", []))).map((m) => [
          m.principalId,
          m.displayName,
        ]),
      );
      const name = membersById.get(ref);
      if (name) names[id] = name;
    } else if (fromSessions) {
      names[id] = fromSessions;
    }
  }
  return names;
}

const keychainRoute =
  (handle: (ctx: ApiCtx, kc: NonNullable<ApiCtx["deps"]["keychain"]>, capability: CapabilityClaims) => Promise<void>) =>
  async (ctx: ApiCtx): Promise<void> => {
    const { res, deps, capability } = ctx;
    if (!deps.keychain)
      return sendJson(res, 503, {
        error: "keychain_unavailable",
        message: "The keychain isn't set up on this server. An operator needs to set CONNECTOR_SECRET_KEY.",
      });
    if (!capability)
      return sendJson(res, 401, {
        error: "unauthorized",
        message: "keychain routes require an agent capability token",
      });
    try {
      return await handle(ctx, deps.keychain, capability);
    } catch (e) {
      if (e instanceof KeychainError) return sendJson(res, e.status, { error: "keychain", message: e.message });
      throw e;
    }
  };

const saveCredential = keychainRoute(async ({ res, deps, body }, kc, { actorId, scopeId }) => {
  const b = body as {
    service?: unknown;
    secret?: unknown;
    files?: unknown;
    envKey?: unknown;
    fields?: unknown;
    target?: unknown;
    host?: unknown;
    accountLabel?: unknown;
    origin?: unknown;
    expiresAt?: unknown;
  };
  const expiresAt = normalizeInboundExpiresAt(b.expiresAt);
  if (!expiresAt.ok) return sendJson(res, 400, { error: "bad_request", message: expiresAt.message });
  const files = Array.isArray(b.files)
    ? (b.files as unknown[])
        .filter(
          (f): f is CredentialFile =>
            typeof (f as CredentialFile)?.path === "string" && typeof (f as CredentialFile)?.contentBase64 === "string",
        )
        .map((f) => ({ path: f.path, contentBase64: f.contentBase64, rawMode: (f as { mode?: unknown }).mode }))
    : undefined;
  const badMode = files?.find(
    (f) =>
      f.rawMode !== undefined &&
      (typeof f.rawMode !== "number" || !Number.isInteger(f.rawMode) || f.rawMode < 0 || f.rawMode > 0o777),
  );
  if (badMode) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: `files[].mode must be an integer between 0 and 511 (octal 0o777); got ${JSON.stringify(badMode.rawMode)} for ${badMode.path}`,
    });
  }
  const cleanFiles: CredentialFile[] | undefined = files?.map(({ path, contentBase64, rawMode }) => ({
    path,
    contentBase64,
    ...(typeof rawMode === "number" ? { mode: rawMode } : {}),
  }));
  let fields: CredentialFieldInput[] | undefined;
  if (b.fields !== undefined) {
    if (
      !Array.isArray(b.fields) ||
      b.fields.length === 0 ||
      b.fields.some(
        (f) =>
          typeof (f as CredentialFieldInput)?.envKey !== "string" ||
          typeof (f as CredentialFieldInput)?.value !== "string",
      )
    ) {
      return sendJson(res, 400, { error: "bad_request", message: "each field needs string envKey and value" });
    }
    fields = b.fields as CredentialFieldInput[];
  }
  if (typeof b.service !== "string" || (typeof b.secret !== "string" && !files?.length && !fields?.length)) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "service plus secret, files[], or fields[] required",
    });
  }
  const meta = await kc.save({
    ownerId: actorId,
    service: b.service,
    ...(typeof b.secret === "string" ? { secret: b.secret } : {}),
    ...(cleanFiles?.length ? { files: cleanFiles } : {}),
    ...(fields?.length ? { fields } : {}),
    ...(typeof b.envKey === "string" ? { envKey: b.envKey } : {}),
    ...(typeof b.target === "string" ? { target: b.target } : {}),
    ...(typeof b.host === "string" ? { host: b.host } : {}),
    ...(typeof b.accountLabel === "string" ? { accountLabel: b.accountLabel } : {}),
    origin: typeof b.origin === "string" ? b.origin : `agent-session:${scopeId}`,
    ...(expiresAt.value !== undefined ? { expiresAt: expiresAt.value } : {}),
  });
  audit(deps, {
    principalId: actorId,
    action: "keychain.save",
    resource: `${meta.service}:${meta.id}`,
    scopeLabel: scopeId,
  });
  return sendJson(res, 200, { credential: meta });
});

const listCredentials = keychainRoute(async ({ res }, kc, { actorId }) => {
  return sendJson(res, 200, { credentials: await kc.listByOwner(actorId) });
});

const keychainOverview = keychainRoute(async ({ res, app, deps }, kc, { actorId }) => {
  const credentials = await kc.listByOwner(actorId);
  const connectorCredentials = (await kc.listConnectorsByOwners([actorId])).get(actorId) ?? [];
  const grants = await kc.listGrants({ ownerId: actorId });
  const asks = (await kc.listAsks({ ownerId: actorId })).filter((ask) => ask.status === "pending");
  const scopeNames = await resolveScopeNames(app, deps, [
    ...grants.map((grant) => grant.audienceScopeId),
    ...asks.map((ask) => ask.requesterScopeId),
  ]);
  return sendJson(res, 200, { credentials, connectorCredentials, grants, asks, scopeNames });
});

const deleteCredential = keychainRoute(async ({ res, deps, params }, kc, { actorId, scopeId }) => {
  const id = params.id!;
  const ok = await kc.remove(actorId, id);
  if (ok) audit(deps, { principalId: actorId, action: "keychain.delete", resource: id, scopeLabel: scopeId });
  return ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "not_found" });
});

const listGrants = keychainRoute(async ({ res }, kc, { actorId, scopeId }) => {
  const mine = await kc.listGrants({ ownerId: actorId });
  const here = await kc.listGrants({ audienceScopeId: scopeId });
  const byId = new Map([...mine, ...here].map((g) => [g.id, g]));
  return sendJson(res, 200, { grants: [...byId.values()] });
});

const revokeGrant = keychainRoute(async ({ res, deps, params }, kc, { actorId, scopeId }) => {
  const id = params.id!;
  const ok = await kc.revokeGrant(actorId, id);
  if (ok) audit(deps, { principalId: actorId, action: "keychain.revoke", resource: id, scopeLabel: scopeId });
  return ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "not_found" });
});

type KeychainStore = NonNullable<ApiCtx["deps"]["keychain"]>;

async function askableCredentials(
  kc: KeychainStore,
  ownerId: string,
): Promise<Array<{ credential: string; service: string; account?: string; handle: string }>> {
  const [entries, connectors] = await Promise.all([kc.listByOwners([ownerId]), kc.listConnectorsByOwners([ownerId])]);
  return [
    ...(entries.get(ownerId) ?? []).map((c) => ({
      credential: c.id,
      service: c.service,
      ...(c.accountLabel ? { account: c.accountLabel } : {}),
      handle: credentialHandle(c),
    })),
    ...(connectors.get(ownerId) ?? []).map((c) => ({
      credential: c.credentialId,
      service: connectorHostLabel(c.host),
      ...(c.accountType ? { account: c.accountType } : {}),
      handle: connectorHandle(c.host, c.accountType),
    })),
  ];
}

async function resolveAskTarget(
  ctx: ApiCtx,
  kc: KeychainStore,
  scopeId: string,
  owner: string,
  service: string,
): Promise<{ credentialId: string } | { status: number; body: Record<string, unknown> }> {
  const found = await ctx.app.resolveRecipient(owner);
  let people: DirectoryMember[] = [];
  if (found.kind === "one") people = [found.member];
  else if (found.kind === "ambiguous") people = found.candidates;
  const inScope = await Promise.all(people.map((person) => ctx.app.belongsToScope(person.principalId, scopeId)));
  const present = people.filter((_, i) => inScope[i]);
  if (present.length !== 1)
    return {
      status: present.length ? 409 : 404,
      body: {
        error: present.length ? "ambiguous_owner" : "unknown_owner",
        message: present.length
          ? "More than one person in this conversation matches that owner; retry with one principalId."
          : "No one in this conversation matches that owner.",
        ...(present.length
          ? { owners: present.map((p) => ({ principalId: p.principalId, name: p.displayName })) }
          : {}),
      },
    };
  const candidates = await askableCredentials(kc, present[0]!.principalId);
  const wanted = service.trim().toLowerCase();
  const matches = candidates.filter((c) => [c.service, c.handle].some((name) => name.toLowerCase() === wanted));
  if (matches.length === 1) return { credentialId: matches[0]!.credential };
  return {
    status: matches.length ? 409 : 404,
    body: {
      error: matches.length ? "ambiguous_credential" : "unknown_credential",
      message: matches.length
        ? "Several of their credentials match; retry with the chosen candidate's credential id."
        : "None of their credentials matches that service; pick one of the candidates.",
      candidates: matches.length ? matches : candidates,
    },
  };
}

const createAsk = keychainRoute(async (ctx, kc, capability) => {
  const { res, app, deps, body } = ctx;
  const actorId = capability.actorId;
  const b = body as {
    credential?: unknown;
    owner?: unknown;
    service?: unknown;
    purpose?: unknown;
    requestedMode?: unknown;
    expiresAt?: unknown;
  };
  const expiresAt = normalizeInboundExpiresAt(b.expiresAt);
  if (!expiresAt.ok) return sendJson(res, 400, { error: "bad_request", message: expiresAt.message });
  const named = typeof b.owner === "string" && typeof b.service === "string";
  if (
    (typeof b.credential !== "string" && !named) ||
    typeof b.purpose !== "string" ||
    (b.requestedMode !== undefined && b.requestedMode !== "once" && b.requestedMode !== "standing")
  ) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: 'expected { owner, service, purpose, requestedMode?: "once"|"standing" } or { credential, purpose, … }',
    });
  }
  const scope = parseScopeId(capability.scopeId);
  if (scope.kind !== "channel" && scope.kind !== "personal" && scope.kind !== "group") {
    return sendJson(res, 403, { error: "forbidden", message: "asks require a personal or shared conversation" });
  }
  let credentialId = typeof b.credential === "string" ? b.credential : undefined;
  if (credentialId === undefined) {
    const target = await resolveAskTarget(ctx, kc, capability.scopeId, b.owner as string, b.service as string);
    if ("status" in target) return sendJson(res, target.status, target.body);
    credentialId = target.credentialId;
  }
  const cred = await kc.getCredential(credentialId);
  if (!cred) return sendJson(res, 404, { error: "not_found", message: "unknown credential" });
  const requester = await app.directoryMember(actorId);
  if (
    !(await app.belongsToScope(actorId, capability.scopeId)) ||
    !(await app.belongsToScope(cred.ownerId, capability.scopeId)) ||
    (scope.kind !== "personal" &&
      (requester?.type !== "internal" || (await app.directoryMember(cred.ownerId))?.type !== "internal"))
  ) {
    return sendJson(res, 403, {
      error: "forbidden",
      message: "the requester and credential owner must have current access to this conversation",
    });
  }
  const context = (await app.listContexts(cred.ownerId)).find((c) => c.scopeId === capability.scopeId);
  const cronId = cronIdOf(capability.threadRef);
  const cron = cronId ? await app.getCron(cronId) : null;
  const dest = resolveCapabilityDestination(capability, undefined);
  const requesterDestination =
    (dest.ok && dest.destination) || (cron?.ownerScopeId === capability.scopeId ? cron.destination : undefined);
  const originRun = capability.runId ? await deps.runs?.get(capability.runId) : null;
  const requesterSeq = originRun && originRun.sessionId === capability.threadRef ? originRun?.turnUserSeq : null;
  const requesterMessageTs =
    originRun && originRun.sessionId === capability.threadRef && originRun.request.origin.kind === "human"
      ? originRun.request.origin.messageTs
      : undefined;
  const { ask, existing } = await kc.createAsk({
    ...(capability.triggered ? { triggered: true } : {}),
    credentialId: cred.id,
    requesterId: actorId,
    requesterScopeId: capability.scopeId,
    ...(requesterSeq != null ? { requesterSeq } : {}),
    ...(requesterMessageTs ? { requesterMessageTs } : {}),
    ...(requesterDestination ? { requesterDestination } : {}),
    ...(capability.threadRef ? { requesterThreadRef: capability.threadRef } : {}),
    purpose: b.purpose,
    ...(b.requestedMode !== undefined ? { requestedMode: b.requestedMode as GrantMode } : {}),
    ...(expiresAt.value !== undefined ? { expiresAt: expiresAt.value } : {}),
  });
  const notice = renderAskNotice({
    ask,
    credential: cred,
    ...(requester?.displayName ? { requesterName: requester.displayName } : {}),
    ...(scope.kind === "channel" && context?.name ? { channelName: context.name } : {}),
    ...(scope.kind === "group" && context?.name ? { scopeName: context.name } : {}),
    ...(cron?.ownerScopeId === capability.scopeId ? { taskTitle: cron.title ?? cron.id } : {}),
  });
  const cardDestination = approvalCardDestination(ask);
  if (cardDestination)
    await deps.deliveries?.enqueue({
      destination: cardDestination,
      text: notice,
      idempotencyKey: `ask:${ask.id}:notice`,
    });
  if (!existing) {
    audit(deps, {
      principalId: actorId,
      action: "keychain.ask",
      resource: `${ask.id} (${cred.service}:${cred.id}→${cred.ownerId})`,
      scopeLabel: capability.scopeId,
    });
  }
  return sendJson(res, 200, { ask, existing });
});

const listAsks = keychainRoute(async ({ res }, kc, { actorId, scopeId }) => {
  const all = await kc.listAsks({});
  const asks = all.filter(
    (a) => samePerson(a.requesterId, actorId) || samePerson(a.ownerId, actorId) || a.requesterScopeId === scopeId,
  );
  return sendJson(res, 200, { asks });
});

async function handleApproval(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, params } = ctx;
  const b = (body ?? {}) as { principalId?: unknown; decision?: unknown };
  if (!deps.keychainApprovals || typeof b.principalId !== "string" || !b.principalId)
    return sendJson(res, 404, { error: "not_found" });
  try {
    if (b.decision !== "once" && b.decision !== "standing" && b.decision !== "deny")
      return sendJson(res, 400, {
        error: "bad_request",
        message: 'expected { principalId, decision: "once"|"standing"|"deny" }',
      });
    const view = await deps.keychainApprovals.decide(params.id!, { externalId: b.principalId }, b.decision);
    return sendJson(res, 200, view);
  } catch (e) {
    if (e instanceof KeychainError) return sendJson(res, e.status, { error: "keychain", message: e.message });
    throw e;
  }
}

export const keychainRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/keychain/credentials", actor: "system", auth: "either", handle: saveCredential },
  { method: "GET", path: "/v1/keychain/credentials", auth: "either", handle: listCredentials },
  { method: "GET", path: "/v1/keychain/overview", auth: "either", handle: keychainOverview },
  { method: "DELETE", path: "/v1/keychain/credentials/:id", actor: "system", auth: "either", handle: deleteCredential },
  { method: "GET", path: "/v1/keychain/grants", auth: "either", handle: listGrants },
  { method: "POST", path: "/v1/keychain/grants/:id/revoke", actor: "system", auth: "either", handle: revokeGrant },
  { method: "POST", path: "/v1/keychain/asks", actor: "system", auth: "either", handle: createAsk },
  { method: "GET", path: "/v1/keychain/asks", auth: "either", handle: listAsks },
  { method: "POST", path: "/v1/keychain/approvals/:id", auth: "source", handle: handleApproval },
];
