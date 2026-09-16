import { createHash } from "node:crypto";
import { scopeId } from "../../types.ts";
import { parseRef } from "../../acl/resource-ref.ts";
import { orgId } from "../../config.ts";
import { principalEntitledToScope } from "../../resolution/context-filter.ts";
import { sendJson } from "../http.ts";
import { activePrincipal, audit } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

export function composioUserId(org: string, principal: string): string {
  return `qm_${createHash("sha256")
    .update(JSON.stringify([org, principal]))
    .digest("hex")}`;
}

async function credential(ctx: ApiCtx): Promise<{ key: string; principal: string } | null> {
  const principal = ctx.actor?.p;
  if (!principal) {
    sendJson(ctx.res, 401, { error: "unauthorized" });
    return null;
  }
  if (!(await activePrincipal(ctx.deps, principal))) {
    sendJson(ctx.res, 403, { error: "forbidden" });
    return null;
  }
  const personal = scopeId("personal", principal);
  const own = (await ctx.deps.keychain?.listByOwner(principal)) ?? [];
  const candidates = own.filter(
    (c) => c.kind === "env" && c.envKey === "COMPOSIO_API_KEY" && (!c.expiresAt || c.expiresAt > Date.now()),
  );
  if (candidates.length > 1) {
    sendJson(ctx.res, 409, {
      error: "ambiguous_credential",
      message: "Choose a single Composio credential in your keychain.",
    });
    return null;
  }
  if (candidates.length === 1) {
    const material = await ctx.deps.keychain!.materializeOwnById(principal, candidates[0]!.id, personal);
    if (material.kind === "env") {
      const key = material.env.find((e) => e.key === "COMPOSIO_API_KEY")?.value;
      if (key) return { key, principal };
    }
    sendJson(ctx.res, 503, { error: "credential_unavailable" });
    return null;
  }
  const org = scopeId("org", orgId());
  const identity = ctx.deps.identity?.classify(principal) ?? { id: principal, type: "internal" as const };
  const grants =
    (await ctx.deps.acl?.grantsOfKind("service-cred", [identity], personal, org, principalEntitledToScope)) ?? [];
  const allowed = new Set(grants.map((g) => parseRef(g.ref).id));
  const records = ((await ctx.deps.serviceCreds?.listServiceCredentials(org)) ?? []).filter(
    (c) => c.enabled && c.hasSecret && c.delivery === "env" && c.envKey === "COMPOSIO_API_KEY" && allowed.has(c.slug),
  );
  if (records.length !== 1) {
    sendJson(ctx.res, records.length ? 409 : 403, {
      error: "composio_unavailable",
      message: "Composio is not available to this account. Ask your administrator to check its credential grant.",
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

async function request(ctx: ApiCtx, key: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await (ctx.deps.composioFetch ?? fetch)(`https://backend.composio.dev/api/v3.1${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error("Composio request failed");
  return (await response.json()) as Record<string, unknown>;
}

async function catalog(ctx: ApiCtx): Promise<void> {
  const access = await credential(ctx);
  if (!access) return;
  const cursor = ctx.url.searchParams.get("cursor") ?? "";
  if (cursor.length > 2048) return sendJson(ctx.res, 400, { error: "bad_cursor" });
  const query = new URLSearchParams({ sort_by: "usage", limit: "1000" });
  if (cursor) query.set("cursor", cursor);
  try {
    const data = await request(ctx, access.key, `/toolkits?${query}`);
    if (!Array.isArray(data.items)) throw new Error("Invalid catalog");
    const items = data.items.flatMap((item) => {
      if (
        !item ||
        typeof item.slug !== "string" ||
        !/^[a-z0-9_-]{1,100}$/.test(item.slug) ||
        typeof item.name !== "string" ||
        (Array.isArray(item.auth_schemes) && item.auth_schemes.every((scheme: unknown) => scheme === "NO_AUTH"))
      )
        return [];
      return [
        {
          id: item.slug,
          logoUrl: `https://logos.composio.dev/api/${item.slug}`,
          name: item.name,
          description: typeof item.meta?.description === "string" ? item.meta.description : "",
        },
      ];
    });
    return sendJson(ctx.res, 200, {
      items,
      nextCursor: typeof data.next_cursor === "string" ? data.next_cursor : null,
    });
  } catch {
    return sendJson(ctx.res, 502, { error: "composio_unavailable", message: "Could not load apps. Please try again." });
  }
}

async function authorize(ctx: ApiCtx): Promise<void> {
  const access = await credential(ctx);
  if (!access) return;
  const toolkit = (ctx.body as { toolkit?: unknown } | null)?.toolkit;
  if (typeof toolkit !== "string" || !/^[a-z0-9_-]{1,100}$/.test(toolkit))
    return sendJson(ctx.res, 400, { error: "invalid_toolkit" });
  const callbackUrl = (ctx.body as { callbackUrl?: unknown }).callbackUrl;
  if (callbackUrl !== undefined) {
    try {
      if (typeof callbackUrl !== "string" || callbackUrl.length > 4096) throw new Error("Invalid callback");
      const callback = new URL(callbackUrl);
      if (
        callback.username ||
        callback.password ||
        callback.hash ||
        !(
          callback.protocol === "https:" ||
          (callback.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname))
        )
      )
        throw new Error("Invalid callback");
    } catch {
      return sendJson(ctx.res, 400, { error: "invalid_callback" });
    }
  }
  try {
    const session = await request(ctx, access.key, "/tool_router/session", {
      user_id: composioUserId(orgId(), access.principal),
      toolkits: { enable: [toolkit] },
      manage_connections: { enable: false },
      workbench: { enable: false },
    });
    if (typeof session.session_id !== "string" || !/^trs_[a-zA-Z0-9_-]+$/.test(session.session_id))
      throw new Error("Invalid session");
    const link = await request(ctx, access.key, `/tool_router/session/${encodeURIComponent(session.session_id)}/link`, {
      toolkit,
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    });
    if (typeof link.connected_account_id !== "string" || !/^ca_[a-zA-Z0-9_-]+$/.test(link.connected_account_id))
      throw new Error("Invalid account");
    const url = new URL(String(link.redirect_url));
    if (
      !(
        (url.origin === "https://connect.composio.dev" && /^\/link\/lk_[a-zA-Z0-9_-]+$/.test(url.pathname)) ||
        (url.origin === "https://app.composio.dev" && /^\/link\/lt_[a-zA-Z0-9_-]+$/.test(url.pathname))
      ) ||
      url.username ||
      url.password
    )
      throw new Error("Invalid authorization URL");
    audit(ctx.deps, {
      principalId: access.principal,
      action: "composio.authorize",
      resource: toolkit,
      scopeLabel: scopeId("personal", access.principal),
    });
    return sendJson(ctx.res, 200, { url: url.href, accountId: link.connected_account_id });
  } catch {
    return sendJson(ctx.res, 502, {
      error: "composio_authorization_failed",
      message: "Could not start authorization. Please try again.",
    });
  }
}

async function connections(ctx: ApiCtx): Promise<void> {
  const access = await credential(ctx);
  if (!access) return;
  const cursor = ctx.url.searchParams.get("cursor") ?? "";
  if (cursor.length > 2048) return sendJson(ctx.res, 400, { error: "bad_cursor" });
  const userId = composioUserId(orgId(), access.principal);
  const query = new URLSearchParams({ user_ids: userId, statuses: "ACTIVE", limit: "100" });
  if (cursor) query.set("cursor", cursor);
  try {
    const data = await request(ctx, access.key, `/connected_accounts?${query}`);
    if (!Array.isArray(data.items)) throw new Error("Invalid accounts");
    const items = data.items.flatMap((item) => {
      if (
        !item ||
        item.user_id !== userId ||
        item.status !== "ACTIVE" ||
        item.is_disabled === true ||
        typeof item.id !== "string" ||
        !/^ca_[a-zA-Z0-9_-]+$/.test(item.id) ||
        typeof item.toolkit?.slug !== "string" ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(item.toolkit.slug)
      )
        return [];
      return [{ id: item.id, toolkit: item.toolkit.slug }];
    });
    ctx.res.setHeader("Cache-Control", "no-store");
    return sendJson(ctx.res, 200, {
      items,
      nextCursor: typeof data.next_cursor === "string" ? data.next_cursor : null,
    });
  } catch {
    return sendJson(ctx.res, 502, {
      error: "composio_unavailable",
      message: "Could not check connected apps. Please try again.",
    });
  }
}

async function identity(ctx: ApiCtx): Promise<void> {
  const principal = ctx.actor?.p ?? ctx.capability?.actorId;
  if (!principal || !(await activePrincipal(ctx.deps, principal)))
    return sendJson(ctx.res, 403, { error: "forbidden" });
  return sendJson(ctx.res, 200, { userId: composioUserId(orgId(), principal) });
}

export const composioRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/composio/connections", auth: "source", handle: connections },
  { method: "GET", path: "/v1/composio/toolkits", auth: "source", handle: catalog },
  { method: "POST", path: "/v1/composio/authorize", auth: "source", handle: authorize },
  { method: "GET", path: "/v1/composio/identity", auth: "either", handle: identity },
];
