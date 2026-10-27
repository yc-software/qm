import { parseSuggestedActivities } from "../../chassis/src/suggested-activities.ts";
import { appsFrameDomain, framedByOwnSurfaces, publicUrl, analyticsConfig, browserErrors } from "./server-env.ts";
import { coreTenantHost, perEdgeTenant } from "../../chassis/src/tenant-hosts.ts";
import { LRUCache } from "lru-cache";
import {
  coreFetch,
  tryParse,
  mintSessionCap,
  type WebCtx,
  fetchCoreGet,
  corePathFor,
  copyParams,
  enc,
  pipeWeb,
  type WebRoute,
  route,
  relay,
  relayRoute,
  readJson,
  relayCore,
  brandingCache,
  readBody,
  portalHeaders,
  relayCap,
} from "./core-relay.ts";
import { coreSigningSecret, CORE_API_URL as CORE, coreOrgId } from "../../chassis/src/env.ts";
import { CAPABILITY_HEADER, fetchCoreText } from "../../chassis/src/core-client.ts";
import { reportFailure } from "../../chassis/src/error-reporting.ts";
import { type ServerResponse } from "node:http";
import { resolveIdentity } from "./identity.ts";
import { json } from "../../chassis/src/http.ts";
import { composioCallbackUrl } from "./composio-return.ts";
import { hasInboxLoopPreview } from "./web-turns.ts";
import { stageFromRequest, sendStaged, stagedFile } from "./uploads.ts";
import { adminRoute } from "./admin-routes.ts";
import { errMessage } from "../../chassis/src/errors.ts";

const suggestedActivities = parseSuggestedActivities(process.env.WEB_UI_SUGGESTED_ACTIVITIES);

const UNTRUSTED_CONTENT_SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";
const fileFrameAncestors = (): string =>
  appsFrameDomain() ? `frame-ancestors 'self' *.${appsFrameDomain()}` : "frame-ancestors 'self'";

const slackUrlCache = perEdgeTenant(
  () =>
    new LRUCache<string, { url: string | null }>({
      max: 1,
      ttl: 5 * 60_000,
      fetchMethod: async () => {
        const r = await coreFetch("GET", "/v1/directory/meta").catch(() => null);
        return {
          url: r?.status === 200 ? (tryParse<{ workspaceUrl?: string | null }>(r.text)?.workspaceUrl ?? null) : null,
        };
      },
    }),
);
const slackWorkspaceUrl = async () => (await slackUrlCache().fetch("url"))!.url;

async function userPermissions(): Promise<string[]> {
  if (!coreSigningSecret()) return [];
  try {
    const cap = await mintSessionCap();
    if (!("token" in cap)) {
      console.warn(`[web-ui] permission lookup: session capability refused (HTTP ${cap.status})`);
      return [];
    }
    const r = await fetch(`${CORE}/v1/admin/whoami`, {
      headers: { "content-type": "application/json", ...coreTenantHost(), [CAPABILITY_HEADER]: cap.token },
      redirect: "manual",
    });
    if (r.status !== 200) {
      console.warn(`[web-ui] permission lookup returned HTTP ${r.status}`);
      return [];
    }
    const j = (await r.json()) as { permissions?: unknown };
    return Array.isArray(j.permissions) ? j.permissions.filter((p): p is string => typeof p === "string") : [];
  } catch (error) {
    reportFailure("web-ui: permission lookup", error);
    return [];
  }
}

function scriptCapableContentType(contentType: string): boolean {
  const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return (
    mime === "text/html" ||
    mime === "application/xhtml+xml" ||
    mime === "image/svg+xml" ||
    mime === "text/xml" ||
    mime === "application/xml" ||
    mime.endsWith("+xml")
  );
}

function upstreamMissing(res: ServerResponse, status: number): void {
  res.writeHead(status === 404 ? 404 : 502, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: status === 404 ? "not_found" : "upstream_error" }));
}

async function serveInboxItemImage(c: WebCtx): Promise<unknown> {
  const { res } = c;
  const r = await fetchCoreGet(
    `${corePathFor("/api/crons/:id/items/:itemId/image", c)}?${copyParams(c, ["ctx", "i"])}`,
  );
  if (!r.ok || !r.body) return upstreamMissing(res, r.status);
  const contentType = r.headers.get("content-type") ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": contentType.startsWith("image/") ? contentType : "application/octet-stream",
    "cache-control": "private, max-age=3600",
    "content-security-policy": "sandbox",
    "x-content-type-options": "nosniff",
  });
  return res.end(Buffer.from(await r.arrayBuffer()));
}

async function serveFileContent(c: WebCtx): Promise<unknown> {
  const { res, user } = c;
  const id = c.params.id!;
  const r = await fetchCoreGet(`/v1/files/${enc(id)}/content?viewer=${enc(user)}`, { redirect: "manual" });
  if (!r.ok || !r.body) return upstreamMissing(res, r.status);
  const contentType = r.headers.get("content-type") ?? "application/octet-stream";
  const csp = scriptCapableContentType(contentType)
    ? `${UNTRUSTED_CONTENT_SANDBOX_CSP}; ${fileFrameAncestors()}`
    : fileFrameAncestors();
  const headers = {
    "content-type": contentType,
    ...(r.headers.get("content-length") ? { "content-length": r.headers.get("content-length")! } : {}),
    ...(r.headers.get("content-disposition") ? { "content-disposition": r.headers.get("content-disposition")! } : {}),
    "x-content-type-options": "nosniff",
  };
  res.writeHead(200, framedByOwnSurfaces(res, headers, csp));
  return pipeWeb(res, r.body);
}

const notImpersonating = async (c: WebCtx) =>
  !resolveIdentity(c.req)?.impersonator || (json(c.res, 403, { error: "forbidden" }), false);

const required =
  (key: string, trim = false) =>
  async ({ res, url }: WebCtx) =>
    Boolean(trim ? url.searchParams.get(key)?.trim() : url.searchParams.get(key)) ||
    (json(res, 400, { error: "bad_request", message: `${key} required` }), false);

export const workspaceRoutes: readonly WebRoute[] = [
  route("GET", "/api/files/by-name/content", async (c) => {
    const { res, url, user } = c;
    const name = url.searchParams.get("name")?.trim();
    if (!name) return json(res, 400, { error: "bad_request", message: "name required" });
    let cursor: string | undefined;
    let match: { id: string; createdAt: number } | undefined;
    for (let page = 0; page < 50; page++) {
      const qs = new URLSearchParams({ viewer: user, limit: "200", q: name });
      if (cursor) qs.set("cursor", cursor);
      const listed = await coreFetch("GET", `/v1/files?${qs.toString()}`);
      if (listed.status !== 200) return relay(res, listed);
      type Listed = { id?: string; name?: string; createdAt?: number; openable?: boolean };
      const body = tryParse<{ owned?: Listed[]; shared?: Listed[]; nextCursor?: string }>(listed.text);
      if (!body) return json(res, 502, { error: "upstream_error" });
      for (const file of [...(body.owned ?? []), ...(body.shared ?? [])]) {
        if (file.name !== name || file.openable === false || typeof file.id !== "string") continue;
        const createdAt = typeof file.createdAt === "number" ? file.createdAt : 0;
        if (!match || createdAt > match.createdAt) match = { id: file.id, createdAt };
      }
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    if (!match) return json(res, 404, { error: "not_found" });
    res.writeHead(302, { location: `/api/files/${enc(match.id)}/content` });
    return res.end();
  }),

  relayRoute("GET", "/api/tool-manifest", { who: "principalId" }),
  relayRoute("GET", "/api/user-model-auth/status", { who: "principalId" }),
  relayRoute("POST", "/api/user-model-auth/account", { principal: true, pick: ["account", "provider"] }),
  relayRoute("POST", "/api/user-model-auth/api-key", { principal: true, pick: ["provider", "apiKey"] }),
  relayRoute("POST", "/api/user-model-auth/disconnect", { principal: true, pick: ["provider"] }),
  relayRoute("POST", "/api/user-model-auth/chatgpt/start", { principal: true }),
  relayRoute("POST", "/api/user-model-auth/chatgpt/poll", { principal: true, pick: ["deviceAuthId", "userCode"] }),
  relayRoute("POST", "/api/user-model-auth/claude/start", { principal: true }),
  relayRoute("POST", "/api/user-model-auth/claude/complete", { principal: true, pick: ["code", "verifier"] }),

  route("GET", "/api/composio/callback", async (c) => {
    c.res.setHeader("Cache-Control", "no-store");
    c.res.setHeader("Referrer-Policy", "no-referrer");
    const result = await coreFetch(
      "POST",
      "/v1/composio/complete-auth",
      JSON.stringify({ sessionUri: c.url.searchParams.get("session_uri") }),
    );
    if (result.status !== 200) return relay(c.res, result);
    const data = JSON.parse(result.text) as { returnTo?: string | null };
    const base = new URL(publicUrl());
    const target = data.returnTo ? new URL(data.returnTo, base) : new URL("./?view=settings", `${publicUrl()}/`);
    if (target.origin !== base.origin) return json(c.res, 400, { error: "invalid_return_url" });
    c.res.writeHead(303, { location: target.href });
    c.res.end();
  }),
  ...["reply-status", "reply"].map((action) => relayRoute("POST", `/api/composio/slack/${action}`, { read: "strict" })),
  relayRoute("GET", "/api/composio/slack"),
  route("POST", "/api/composio/slack/authorize", async (c) => {
    const body = await readJson<{ returnTo?: unknown; state?: unknown }>(c.req, c.res, false);
    if (!body) return;
    const callback = composioCallbackUrl(publicUrl(), body.returnTo, body.state);
    if (!callback) return json(c.res, 400, { error: "invalid_return_url" });
    const url = new URL(callback);
    url.searchParams.delete("composioReturn");
    url.searchParams.set("slackReturn", String(body.state));
    c.res.setHeader("Cache-Control", "no-store");
    return relayCore(c.res, "POST", "/v1/composio/slack/authorize", JSON.stringify({ callbackUrl: url.href }));
  }),
  relayRoute("POST", "/api/composio/slack/complete", { pick: ["ticket"], read: "strict", noStore: true }),
  relayRoute("GET", "/api/composio/toolkits", { query: (c) => ({ cursor: c.url.searchParams.get("cursor") ?? "" }) }),
  relayRoute("GET", "/api/composio/connections", {
    query: (c) => ({ cursor: c.url.searchParams.get("cursor") ?? "" }),
    noStore: true,
  }),
  route("POST", "/api/composio/authorize", async (c) => {
    const body = await readJson<{ toolkit?: unknown; returnTo?: unknown; state?: unknown }>(c.req, c.res, false);
    if (!body) return;
    c.res.setHeader("Cache-Control", "no-store");
    const callbackUrl = composioCallbackUrl(publicUrl(), body.returnTo, body.state);
    if (!callbackUrl && (body.returnTo !== undefined || body.state !== undefined)) {
      return json(c.res, 400, { error: "invalid_return_url" });
    }
    return relayCore(
      c.res,
      "POST",
      "/v1/composio/authorize",
      JSON.stringify({ toolkit: body.toolkit, ...(callbackUrl ? { callbackUrl } : {}) }),
    );
  }),
  relayRoute("POST", "/api/composio/disconnect", { pick: ["accountId"], read: "strict", noStore: true }),
  {
    match: (_method, pathname) => pathname === "/me",
    handle: async (c) => {
      const { req, res, user } = c;
      const [allPermissions, workspaceUrl, authStatus, activityConfig, companyBranding] = await Promise.all([
        userPermissions(),
        slackWorkspaceUrl(),
        coreFetch("GET", `/v1/user-model-auth/status?principalId=${enc(user)}`, "", 5_000).catch(() => null),
        coreFetch("GET", "/v1/suggested-activities", "", 2_000)
          .then((response) => response.status === 200 && JSON.parse(response.text).enabled === true)
          .catch(() => false),
        brandingCache().forRender(),
      ]);
      if (authStatus === null || authStatus.status !== 200) {
        return json(res, 503, {
          error: "unavailable",
          message: "the assistant is briefly unavailable — retry shortly",
        });
      }
      const parsed = JSON.parse(authStatus.text) as {
        individualModelAuth?: boolean;
        account?: string;
        connections?: { provider: string }[];
      };
      const permissions = allPermissions.filter((permission) => permission !== "inbox");
      if (await hasInboxLoopPreview(user)) permissions.push("inbox");
      return json(res, 200, {
        user,
        org: coreOrgId(),
        companyName: companyBranding.orgName?.trim() || null,
        ...(analyticsConfig && !resolveIdentity(req)?.impersonator ? { analytics: analyticsConfig } : {}),
        ...(browserErrors && !resolveIdentity(req)?.impersonator ? { browserErrors } : {}),
        slackWorkspaceUrl: workspaceUrl,
        individualModelAuth: parsed.individualModelAuth === true,
        modelAuthConnected:
          parsed.connections?.some(
            (c) => !parsed.account || parsed.account === "personal" || parsed.account === c.provider,
          ) ?? false,
        impersonatedBy: resolveIdentity(req)?.impersonator ?? null,
        displayName: resolveIdentity(req)?.name ?? null,
        ...(activityConfig ? { suggestedActivitiesGeneration: true } : {}),
        ...(suggestedActivities.length && !activityConfig ? { suggestedActivities } : {}),
        permissions,
      });
    },
  },
  route("POST", "/api/blobs", async (c) => {
    const upload = await stageFromRequest(c);
    if (upload) sendStaged(c.res, upload);
  }),
  route("POST", "/api/files/upload", async (c) => {
    const file = await stagedFile(c);
    if (!file) return;
    const scope = c.url.searchParams.get("scope");
    const body = JSON.stringify({ principalId: c.user, ...(scope ? { scopeId: scope } : {}), ...file });
    return relay(c.res, await coreFetch("POST", "/v1/files/upload", body));
  }),
  relayRoute("GET", "/api/resources/search", {
    query: (c) => `principalId=${enc(c.user)}&q=${enc((c.url.searchParams.get("q") ?? "").slice(0, 500))}`,
  }),
  relayRoute("GET", "/api/search", {
    core: "/v1/sessions/search",
    query: (c) => {
      const limit = c.url.searchParams.get("limit");
      return `principalId=${enc(c.user)}&q=${enc(c.url.searchParams.get("q") ?? "")}${limit ? `&limit=${enc(limit)}` : ""}`;
    },
  }),
  relayRoute("GET", "/api/sessions", {
    query: (c) => copyParams(c, ["limit", "before", "status", "surface", "scope", "q"], undefined, true, 500),
  }),
  relayRoute("GET", "/api/sessions/row", { query: (c) => copyParams(c, ["id", "threadRef"], undefined, true) }),
  relayRoute("GET", "/api/sessions/:id/children", { who: "principalId" }),
  relayRoute("GET", "/api/contexts", { who: "principalId" }),
  relayRoute("GET", "/api/contexts/:scope/ambient-policy", {
    core: "/v1/contexts/policy",
    query: (c) => `principalId=${enc(c.user)}&scope=${enc(c.params.scope!)}`,
  }),
  relayRoute("PUT", "/api/contexts/:scope/ambient-policy", {
    core: "/v1/contexts/policy",
    read: "json",
    shape: (p, c) => ({
      principalId: c.user,
      scope: c.params.scope,
      instructions: p.instructions,
      instructionsVersion: p.instructionsVersion,
      bots: p.bots,
      ambientEnabled: p.ambientEnabled,
      baseUpdatedAt: p.baseUpdatedAt,
    }),
  }),
  ...(
    [
      ["POST", "/api/projects", "name", 200],
      ["PATCH", "/api/projects/:id", "name", 200],
      ["POST", "/api/projects/:id/members", "memberId", Infinity],
      ["PUT", "/api/projects/:id/slack-channel", "channel", 200],
    ] as const
  ).map(([method, path, field, max]): WebRoute => ({
    method,
    path,
    handle: async (c) => {
      const p = await readJson<Record<string, unknown>>(c.req, c.res);
      if (!p) return;
      const value = p[field];
      const text = typeof value === "string" ? value.trim().slice(0, max) : "";
      if (!text) return json(c.res, 400, { error: "bad_request", message: `${field} required` });
      return relayCore(c.res, method, corePathFor(path, c), JSON.stringify({ principalId: c.user, [field]: text }));
    },
  })),
  relayRoute("DELETE", "/api/projects/:id/slack-channel", { principal: true }),
  relayRoute("DELETE", "/api/projects/:id/members/:memberId", { principal: true }),
  relayRoute("GET", "/api/directory/resolve", {
    gate: required("q", true),
    query: (c) => `q=${enc(c.url.searchParams.get("q")!.trim().slice(0, 80))}`,
  }),
  ...[
    { leaf: "", keys: ["timezone", "poll", "refresh"], timeoutMs: 60_000 },
    { leaf: "/dismiss", keys: ["id"], timeoutMs: 15_000 },
  ].map(({ leaf, keys, timeoutMs }): WebRoute => ({
    method: "POST",
    path: `/api/suggested-activities${leaf}`,
    handle: async (c) => {
      const input = JSON.parse((await readBody(c.req)) || "{}") as Record<string, unknown>;
      const body = {
        principalId: c.user,
        ...(leaf ? {} : { seeds: suggestedActivities }),
        ...Object.fromEntries(keys.map((key) => [key, input[key]])),
      };
      const response = await coreFetch("POST", `/v1/suggested-activities${leaf}`, JSON.stringify(body), timeoutMs);
      return json(c.res, response.status, JSON.parse(response.text));
    },
  })),
  relayRoute("GET", "/api/ui-state", {
    query: (c) => ({ principalId: c.user, key: c.url.searchParams.get("key") ?? "" }),
  }),
  relayRoute("PUT", "/api/ui-state", { read: "json", shape: (p, c) => ({ ...p, principalId: c.user }) }),
  { match: (_method, pathname) => pathname.startsWith("/api/admin/"), handle: adminRoute },
  relayRoute("GET", "/api/ui-canvas/:sessionId", {
    gate: notImpersonating,
    core: "/v1/ui/canvases/:sessionId",
    query: (c) => ({ principalId: c.user }),
  }),
  route("GET", "/api/ui-canvas/:sessionId/script.js", async (c) => {
    if (!(await notImpersonating(c))) return;
    const { res, url, user } = c;
    const sessionId = c.params.sessionId!;
    const r = await coreFetch("GET", `/v1/ui/canvases/${enc(sessionId)}?${new URLSearchParams({ principalId: user })}`);
    if (r.status !== 200) return relay(res, r);
    let canvas: { js?: unknown; rev?: unknown } | undefined;
    try {
      canvas = (JSON.parse(r.text) as { canvas?: { js?: unknown; rev?: unknown } }).canvas;
    } catch (error) {
      reportFailure("web-ui: canvas script bad core response", error);
      return json(res, 502, { error: "bad_core_response", message: errMessage(error) });
    }
    if (typeof canvas?.js !== "string") return json(res, 404, { error: "not_found" });
    if (String(canvas.rev) !== url.searchParams.get("rev")) return json(res, 409, { error: "stale_revision" });
    res.writeHead(200, {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(
      `((canvas) => {\n${canvas.js}\n})(window.qmUiCanvasTake?.(${JSON.stringify(sessionId)}, ${Number(canvas.rev)}));\n`,
    );
  }),
  relayRoute("POST", "/api/ui-canvas/observe/:callId", {
    gate: notImpersonating,
    core: "/v1/ui/observe/:callId/result",
    read: "strict",
    shape: (p, c) => ({ snapshot: p.snapshot, principalId: c.user }),
  }),
  relayRoute("POST", "/api/ui-canvas/:sessionId", {
    gate: notImpersonating,
    core: "/v1/ui/canvases/:sessionId",
    read: "strict",
    shape: (p, c) => ({ pinned: p.pinned, dismiss: p.dismiss, principalId: c.user }),
  }),
  relayRoute("GET", "/api/inbox", {
    query: (c) => copyParams(c, ["cursor", "cronId", "view", "itemId", "filter"]),
  }),
  relayRoute("POST", "/api/inbox/sent-chat", { raw: true, noStore: true }),
  relayRoute("POST", "/api/inbox/selection", { core: "/v1/inbox", to: "PUT", who: "principalId", raw: true }),
  relayRoute("POST", "/api/inbox/sync-cron", { who: "principalId", raw: true }),
  relayRoute("GET", "/api/crons/:id/items", { query: (c) => copyParams(c, ["state"]) }),
  relayRoute("GET", "/api/crons/:id/items/:itemId", {
    query: (c) => copyParams(c, c.url.searchParams.get("refreshSource") === "1" ? ["refreshSource"] : []),
  }),
  route("GET", "/api/crons/:id/items/:itemId/image", serveInboxItemImage),
  ...["action", "followup"].map((leaf) =>
    relayRoute("POST", `/api/crons/:id/items/:itemId/${leaf}`, { who: "principalId", raw: true }),
  ),
  ...["runtime-config", "channel-header-pin"].flatMap((leaf): WebRoute[] => [
    relayRoute("GET", `/api/${leaf}`, {
      query: (c) => ({
        principalId: c.user,
        scopeId: c.url.searchParams.get("scopeId") || `personal:${c.user}`,
        ...(leaf === "runtime-config" && c.url.searchParams.get("account") === "company" ? { account: "company" } : {}),
      }),
    }),
    relayRoute("PUT", `/api/${leaf}`, {
      read: "json",
      shape: (p, c) => ({
        ...p,
        principalId: c.user,
        scopeId: typeof p.scopeId === "string" && p.scopeId ? p.scopeId : `personal:${c.user}`,
      }),
    }),
  ]),
  relayRoute("GET", "/api/scope-resources", {
    gate: required("scope"),
    query: (c) => ({ principalId: c.user, scope: c.url.searchParams.get("scope")! }),
  }),
  relayRoute("GET", "/api/skills", {
    query: (c) => copyParams(c, c.url.searchParams.get("includeShadowed") === "1" ? ["includeShadowed"] : []),
  }),
  relayRoute("GET", "/api/skills/:id", { who: "principalId" }),
  relayRoute("POST", "/api/skills", {
    principal: true,
    pick: ["name", "description", "body", "scopeId"],
    strings: true,
    read: "json",
  }),
  relayRoute("PUT", "/api/skills/:id", { principal: true, pick: ["description", "body"], strings: true, read: "json" }),
  relayRoute("DELETE", "/api/skills/:id", { principal: true }),
  relayRoute("POST", "/api/skills/:id/restore", { principal: true }),
  relayRoute("POST", "/api/sessions/:id/share", { principal: true, pick: ["audience"], read: "json", noStore: true }),
  relayRoute("POST", "/api/sessions/:id/title", { principal: true }),
  relayRoute("POST", "/api/sessions/:id/detach", { principal: true }),
  relayRoute("POST", "/api/sessions/:id/goal/cancel", { principal: true }),
  relayRoute("POST", "/api/sessions/:id/fork", {
    principal: true,
    read: "json",
    shape: (p) => (typeof p.upToSeq === "number" ? { upToSeq: p.upToSeq } : {}),
  }),
  relayRoute("GET", "/api/sessions/:id/approvals", { who: "viewer" }),
  relayRoute("GET", "/api/sessions/:id/background/:pid/output", {
    query: (c) => `viewer=${enc(c.user)}&sinceCursor=${enc(c.url.searchParams.get("sinceCursor") ?? "0")}`,
  }),
  relayRoute("GET", "/api/sessions/:id/background", { who: "viewer" }),
  relayRoute("GET", "/api/sessions/:id/items/:seq", {
    gate: async (c) => /^\d+$/.test(c.params.seq!) || (json(c.res, 404, { error: "not found" }), false),
    who: "viewer",
  }),
  route("GET", "/api/sessions/:id", async (c) => {
    const { res, user } = c;
    const id = c.params.id!;
    const qs = copyParams(c, ["tailTurns", "sinceSeq", "beforeSeq"], { viewer: user }, true);
    const cancel = new AbortController();
    const onClose = () => cancel.abort();
    res.once("close", onClose);
    try {
      return relay(
        res,
        await fetchCoreText({
          origin: CORE,
          secret: coreSigningSecret(),
          method: "GET",
          path: `/v1/sessions/${enc(id)}?${qs.toString()}`,
          headers: portalHeaders(),
          signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(30_000)]),
          retrySafeRead: true,
        }),
      );
    } catch (error) {
      if (!cancel.signal.aborted) throw error;
    } finally {
      res.off("close", onClose);
    }
  }),
  route("GET", "/api/files/:id/content", serveFileContent),
  route("GET", "/api/files/:id/content/:name", serveFileContent),
  relayRoute("GET", "/api/files", {
    query: (c) => copyParams(c, ["limit", "cursor", "scope"], { viewer: c.user }),
  }),
  relayRoute("GET", "/api/memory", { who: "principalId" }),
  relayRoute("PATCH", "/api/memory", { principal: true, pick: ["facts"], read: "strict" }),
  relayRoute("DELETE", "/api/memory", { principal: true, pick: ["ids"], read: "strict" }),
  route("POST", "/api/sessions/:id", async (c) => {
    const p = await readJson<Record<string, unknown>>(c.req, c.res, false);
    if (!p) return;
    const nullableText = (v: unknown) => v === null || typeof v === "string";
    const flag = (v: unknown) => typeof v === "boolean";
    const accepts = { title: nullableText, archived: flag, pinned: flag, color: nullableText, unread: flag };
    const patch = Object.fromEntries(Object.entries(accepts).flatMap(([k, ok]) => (ok(p[k]) ? [[k, p[k]]] : [])));
    if (!Object.keys(patch).length)
      return json(c.res, 400, {
        error: "bad_request",
        message: "title, archived, pinned, color, or unread required",
      });
    return relayCore(
      c.res,
      "POST",
      corePathFor("/api/sessions/:id", c),
      JSON.stringify({ principalId: c.user, ...patch }),
    );
  }),
  relayRoute("GET", "/api/connectors", { core: "/v1/connectors/oauth/status", who: "principalId" }),
  route("POST", "/api/connectors/:provider/start", async (c) => {
    const { res, user } = c;
    const provider = c.params.provider!;
    const callback = `${publicUrl()}/v1/connectors/oauth/${enc(provider)}/callback`;
    const body = await readJson<{ returnTo?: unknown }>(c.req, res);
    if (!body) return;
    const returnTo =
      typeof body?.returnTo === "string" &&
      body.returnTo.startsWith("/") &&
      !body.returnTo.startsWith("//") &&
      !body.returnTo.includes("\\") &&
      new URL(body.returnTo, publicUrl()).origin === new URL(publicUrl()).origin
        ? body.returnTo
        : "/keychain";
    const params = new URLSearchParams({ principalId: user, redirectUri: callback, returnTo });
    const corePath = `/v1/connectors/oauth/${enc(provider)}/start?${params.toString()}`;
    return relayCore(res, "GET", corePath);
  }),
  route("POST", "/api/connectors/revoke", async (c) => {
    const { req, res, user } = c;
    const p = await readJson<{ provider?: unknown; host?: unknown }>(req, res, false);
    if (!p) return;
    const provider = typeof p.provider === "string" ? p.provider : "";
    const host = typeof p.host === "string" ? p.host : "";
    if (!provider && !host) return json(res, 400, { error: "bad_request", message: "provider or host required" });
    const rawBody = JSON.stringify({ principalId: user, ...(provider ? { provider } : { host }) });
    return relayCore(res, "POST", "/v1/connectors/oauth/revoke", rawBody);
  }),
  relayRoute("GET", "/api/keychain/credentials", { cap: true }),
  relayRoute("GET", "/api/keychain/overview", { cap: true }),
  relayRoute("POST", "/api/keychain/approvals/:id", { principal: true, pick: ["decision"], read: "strict" }),
  relayRoute("POST", "/api/keychain/grants/:id/revoke", { cap: true, body: {} }),
  relayRoute("POST", "/api/keychain/drops", {
    cap: true,
    pick: ["service", "purpose", "envKey"],
    strings: true,
    read: "strict",
  }),
  route("DELETE", "/api/keychain/credentials/:id", (c) =>
    c.params.id
      ? relayCap(c.res, "DELETE", `/v1/keychain/credentials/${enc(c.params.id)}`)
      : json(c.res, 400, { error: "bad_request", message: "credential id required" }),
  ),
];
