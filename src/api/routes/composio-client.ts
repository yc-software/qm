import { createHash } from "node:crypto";
import { isBackendCredential } from "../../credentials/keychain.ts";
import { livePersonCapability } from "../artifact-share.ts";
import { personIds, samePerson } from "../../directory/person.ts";
import { scopeId } from "../../types.ts";
import { parseRef } from "../../acl/resource-ref.ts";
import { orgId } from "../../config.ts";
import { principalEntitledToScope } from "../../resolution/context-filter.ts";
import { sendJson } from "../http.ts";
import { httpFailure } from "../../util/errors.ts";
import { activePrincipal } from "./shared.ts";
import type { ApiCtx } from "./route.ts";

export function composioUserId(org: string, principal: string): string {
  return `qm_${createHash("sha256")
    .update(JSON.stringify([org, principal]))
    .digest("hex")}`;
}

export function composioUserIds(principal: string): string[] {
  return [...new Set(personIds(principal).map((id) => composioUserId(orgId(), id)))];
}

export async function activeRun(ctx: ApiCtx): Promise<boolean> {
  const cap = ctx.capability;
  if (!cap) return true;
  const run = cap.runId ? await ctx.deps.runs?.get(cap.runId) : null;
  if (
    !run ||
    run.status !== "running" ||
    !cap.runLeaseToken ||
    run.leaseToken !== cap.runLeaseToken ||
    run.attempts !== cap.runAttempt ||
    run.sessionId !== cap.threadRef ||
    !samePerson(run.request.actor.id, cap.actorId) ||
    (run.leaseExpiresAt ?? 0) <= Date.now()
  ) {
    sendJson(ctx.res, 403, {
      error: "inactive_run",
      message: "Connected app access requires this run's current capability.",
    });
    return false;
  }
  return true;
}

export async function credential(ctx: ApiCtx): Promise<{ key: string; principal: string } | null> {
  if (!(await activeRun(ctx))) return null;
  const principal = ctx.capability?.actorId ?? ctx.actor?.p;
  if (!principal) {
    sendJson(ctx.res, 401, { error: "unauthorized" });
    return null;
  }
  if (!(await activePrincipal(ctx.deps, principal))) {
    sendJson(ctx.res, 403, { error: "forbidden" });
    return null;
  }
  const personal = scopeId("personal", principal);
  if (ctx.capability) {
    const cap = ctx.capability;
    const shared = cap.scopeId !== personal;
    if (
      cap.ownerConnections !== true ||
      cap.deployment ||
      cap.botActor ||
      (shared &&
        livePersonCapability(cap) &&
        (await ctx.deps.config?.resolveSharingPostureDurable(personal, cap.scopeId)) !== "open")
    ) {
      sendJson(ctx.res, 403, {
        error: "private_connections",
        message:
          "Use your connected apps in your own conversation, or explicitly open sharing to this conversation on a human-started turn.",
      });
      return null;
    }
  }
  const own = (await ctx.deps.keychain?.listByOwner(principal)) ?? [];
  const candidates = own.filter(
    (c) => c.kind === "env" && isBackendCredential(c) && (!c.expiresAt || c.expiresAt > Date.now()),
  );
  if (candidates.length > 1) {
    sendJson(ctx.res, 409, {
      error: "ambiguous_credential",
      message: "Choose a single Composio credential in your keychain.",
    });
    return null;
  }
  if (candidates.length === 1) {
    const key = await ctx.deps.keychain!.composioKey(principal, candidates[0]!.id);
    if (key) return { key, principal };
    sendJson(ctx.res, 503, { error: "credential_unavailable" });
    return null;
  }
  const org = scopeId("org", orgId());
  const identity = ctx.deps.identity?.classify(principal) ?? { id: principal, type: "internal" as const };
  const audience = ctx.capability && ctx.capability.scopeId !== personal ? ctx.capability.keychainMembers : [identity];
  if (!audience?.length || audience.some((member) => member.type !== "internal")) {
    sendJson(ctx.res, 403, { error: "unknown_audience" });
    return null;
  }
  const grants =
    (await ctx.deps.acl?.grantsOfKind(
      "service-cred",
      audience,
      ctx.capability?.scopeId ?? personal,
      org,
      principalEntitledToScope,
    )) ?? [];
  const allowed = new Set(grants.map((g) => parseRef(g.ref).id));
  const records = ((await ctx.deps.serviceCreds?.listServiceCredentials(org)) ?? []).filter(
    (c) => c.enabled && c.hasSecret && c.delivery === "env" && c.envKey === "COMPOSIO_API_KEY" && allowed.has(c.slug),
  );
  if (records.length !== 1) {
    sendJson(ctx.res, records.length ? 409 : 403, {
      error: "composio_unavailable",
      message: "App connections aren’t available for your account yet. Ask your administrator to enable them.",
    });
    return null;
  }
  const record = await ctx.deps.serviceCreds!.getServiceCredentialSecret(org, records[0]!.slug);
  if (!record?.enabled || record.delivery !== "env" || record.envKey !== "COMPOSIO_API_KEY" || !record.secret) {
    sendJson(ctx.res, 403, { error: "composio_unavailable" });
    return null;
  }
  return { key: record.secret, principal };
}

export async function request(
  ctx: ApiCtx,
  key: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await (ctx.deps.composioFetch ?? fetch)(`https://backend.composio.dev/api/v3.1${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Composio request failed: ${await httpFailure(response)}`);
  return (await response.json()) as Record<string, unknown>;
}
