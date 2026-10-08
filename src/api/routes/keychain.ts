import {
  KeychainError,
  renderAskNotice,
  renderUseScript,
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
import { audit, resolveCapabilityDestination } from "./shared.ts";
import { swallowAs } from "../../util/errors.ts";
import { livePersonCapability } from "../artifact-share.ts";
import { cronIdOf } from "../../sessions/session-store.ts";

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

async function handleKeychain(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, pathname, method, body, capability, params } = ctx;
  if (!deps.keychain)
    return sendJson(res, 503, {
      error: "keychain_unavailable",
      message: "The keychain isn't set up on this server. An operator needs to set CONNECTOR_SECRET_KEY.",
    });
  if (!capability)
    return sendJson(res, 401, { error: "unauthorized", message: "keychain routes require an agent capability token" });
  const kc = deps.keychain;
  const actorId = capability.actorId;
  try {
    if (method === "POST" && pathname === "/v1/keychain/credentials") {
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
                typeof (f as CredentialFile)?.path === "string" &&
                typeof (f as CredentialFile)?.contentBase64 === "string",
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
        origin: typeof b.origin === "string" ? b.origin : `agent-session:${capability.scopeId}`,
        ...(expiresAt.value !== undefined ? { expiresAt: expiresAt.value } : {}),
      });
      audit(deps, {
        principalId: actorId,
        action: "keychain.save",
        resource: `${meta.service}:${meta.id}`,
        scopeLabel: capability.scopeId,
      });
      return sendJson(res, 200, { credential: meta });
    }

    if (method === "GET" && pathname === "/v1/keychain/credentials") {
      return sendJson(res, 200, { credentials: await kc.listByOwner(actorId) });
    }

    if (method === "GET" && pathname === "/v1/keychain/overview") {
      const credentials = await kc.listByOwner(actorId);
      const connectorCredentials = (await kc.listConnectorsByOwners([actorId])).get(actorId) ?? [];
      const grants = await kc.listGrants({ ownerId: actorId });
      const asks = (await kc.listAsks({ ownerId: actorId })).filter((ask) => ask.status === "pending");
      const scopeNames = await resolveScopeNames(app, deps, [
        ...grants.map((grant) => grant.audienceScopeId),
        ...asks.map((ask) => ask.requesterScopeId),
      ]);
      return sendJson(res, 200, { credentials, connectorCredentials, grants, asks, scopeNames });
    }

    if (method === "DELETE" && pathname.startsWith("/v1/keychain/credentials/")) {
      const id = params.id!;
      const ok = await kc.remove(actorId, id);
      if (ok)
        audit(deps, { principalId: actorId, action: "keychain.delete", resource: id, scopeLabel: capability.scopeId });
      return ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "not_found" });
    }

    if (method === "GET" && pathname === "/v1/keychain/grants") {
      const mine = await kc.listGrants({ ownerId: actorId });
      const here = await kc.listGrants({ audienceScopeId: capability.scopeId });
      const byId = new Map([...mine, ...here].map((g) => [g.id, g]));
      return sendJson(res, 200, { grants: [...byId.values()] });
    }

    if (method === "POST" && pathname.startsWith("/v1/keychain/grants/") && pathname.endsWith("/revoke")) {
      const id = params.id!;
      const ok = await kc.revokeGrant(actorId, id);
      if (ok)
        audit(deps, { principalId: actorId, action: "keychain.revoke", resource: id, scopeLabel: capability.scopeId });
      return ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "not_found" });
    }

    if (method === "POST" && pathname === "/v1/keychain/asks") {
      const b = body as { credential?: unknown; purpose?: unknown; requestedMode?: unknown; expiresAt?: unknown };
      const expiresAt = normalizeInboundExpiresAt(b.expiresAt);
      if (!expiresAt.ok) return sendJson(res, 400, { error: "bad_request", message: expiresAt.message });
      if (
        typeof b.credential !== "string" ||
        typeof b.purpose !== "string" ||
        (b.requestedMode !== undefined && b.requestedMode !== "once" && b.requestedMode !== "standing")
      ) {
        return sendJson(res, 400, {
          error: "bad_request",
          message: 'expected { credential, purpose, requestedMode?: "once"|"standing" }',
        });
      }
      const scope = parseScopeId(capability.scopeId);
      if (scope.kind !== "channel" && scope.kind !== "personal" && scope.kind !== "group") {
        return sendJson(res, 403, { error: "forbidden", message: "asks require a personal or shared conversation" });
      }
      const cred = await kc.getCredential(b.credential);
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
    }

    if (method === "GET" && pathname === "/v1/keychain/asks") {
      const all = await kc.listAsks({});
      const asks = all.filter(
        (a) =>
          samePerson(a.requesterId, actorId) ||
          samePerson(a.ownerId, actorId) ||
          a.requesterScopeId === capability.scopeId,
      );
      return sendJson(res, 200, { asks });
    }

    if (method === "POST" && pathname === "/v1/keychain/use") {
      const b = body as { grant?: unknown; credential?: unknown };
      if (typeof b.grant !== "string" && typeof b.credential !== "string") {
        return sendJson(res, 400, {
          error: "bad_request",
          message: "expected { grant } or { credential } (your own, personal conversation only)",
        });
      }
      let m;
      if (typeof b.grant === "string") {
        m = await kc.materialize(b.grant, capability.scopeId, actorId);
      } else {
        if (!livePersonCapability(capability)) {
          return sendJson(res, 403, {
            error: "forbidden",
            message:
              "own-credential use is implied only on a turn its owner sent live, or a subagent delegated from one — this turn is neither; use an existing grant or POST /v1/keychain/asks to request owner approval, then wait",
          });
        }
        m = await kc.materializeOwnById(actorId, b.credential as string, capability.scopeId);
      }
      deps.credentialUsage?.record({
        slug: `keychain:${m.service}:${m.credentialId}`,
        host: m.service,
        status: "materialized",
        scopeLabel: capability.scopeId,
        principalId: actorId,
      });
      audit(deps, {
        principalId: actorId,
        action: "keychain.use",
        resource: m.grantId ? `${m.credentialId} (grant ${m.grantId})` : `${m.credentialId} (own)`,
        scopeLabel: capability.scopeId,
      });
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(renderUseScript(m));
      return;
    }
  } catch (e) {
    if (e instanceof KeychainError) return sendJson(res, e.status, { error: "keychain", message: e.message });
    throw e;
  }
  return sendJson(res, 404, { error: "not_found" });
}

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
  { method: "POST", path: "/v1/keychain/credentials", auth: "either", handle: handleKeychain },
  { method: "GET", path: "/v1/keychain/credentials", auth: "either", handle: handleKeychain },
  { method: "GET", path: "/v1/keychain/overview", auth: "either", handle: handleKeychain },
  { method: "DELETE", path: "/v1/keychain/credentials/:id", auth: "either", handle: handleKeychain },
  { method: "GET", path: "/v1/keychain/grants", auth: "either", handle: handleKeychain },
  { method: "POST", path: "/v1/keychain/grants/:id/revoke", auth: "either", handle: handleKeychain },
  { method: "POST", path: "/v1/keychain/asks", auth: "either", handle: handleKeychain },
  { method: "GET", path: "/v1/keychain/asks", auth: "either", handle: handleKeychain },
  { method: "POST", path: "/v1/keychain/use", auth: "either", handle: handleKeychain },
  { method: "POST", path: "/v1/keychain/approvals/:id", auth: "source", handle: handleApproval },
];
