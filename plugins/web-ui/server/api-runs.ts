import { type ServerResponse, type IncomingMessage } from "node:http";
import {
  coreJson,
  enc,
  coreFetch,
  relay,
  type WebCtx,
  type WebRoute,
  route,
  relayRoute,
  readJson,
  readBody,
  tryParse,
  relayCore,
  fetchCoreGet,
  pipeWeb,
  copyParams,
} from "./core-relay.ts";
import { json, PayloadTooLargeError } from "../../chassis/src/http.ts";
import { resolveIdentity } from "./identity.ts";
import {
  approvalScope,
  namespacedSendKey,
  SUBAGENT_THREAD_PREFIX,
  resolveWebConversation,
  isWebThread,
  channelLabel,
  webTurnBase,
} from "./web-turns.ts";
import { SSE_HEADERS, eventClients, SSE_HEARTBEAT_MS } from "./live-feeds.ts";
import { randomBytes } from "node:crypto";

type Deployment = Record<string, unknown>;

async function gateManageDeployment(res: ServerResponse, user: string, id: string): Promise<boolean> {
  const list = await coreJson<{ deployments?: Deployment[] }>(res, `/v1/deployments?principalId=${enc(user)}`);
  if (!list) return false;
  const d = (list.deployments ?? []).find((x) => x.id === id || x.name === id);
  if (!d) {
    json(res, 404, { error: "not_found" });
    return false;
  }
  if (d.permission !== "write") {
    json(res, 403, { error: "forbidden", message: "you do not manage this deployment" });
    return false;
  }
  return true;
}

async function postTurnAndMint(
  req: IncomingMessage,
  res: ServerResponse,
  turn: Record<string, unknown>,
): Promise<void> {
  const startedAt = performance.now();
  let runId: string | undefined;
  res.once("finish", () => {
    console.info("[web] turn response", {
      runId,
      status: res.statusCode,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
  });
  const r = await coreFetch(
    "POST",
    `/v1/turns?async=1`,
    JSON.stringify({ ...turn, ...(resolveIdentity(req)?.impersonator ? { analyticsSuppressed: true } : {}) }),
  );
  if (r.status >= 200 && r.status < 300) {
    try {
      const parsed = JSON.parse(r.text) as Record<string, unknown> & { runId?: string };
      runId = parsed.runId;
      if (runId) return json(res, r.status, parsed);
    } catch {
      void 0;
    }
  }
  relay(res, r);
}

interface CoreApprovalRecord {
  sessionId?: unknown;
  request?: {
    actor?: { externalId?: unknown };
    conversation?: { threadRef?: unknown; kind?: unknown };
  } & Record<string, unknown>;
}

const withWebUrl = (d: Record<string, unknown>) => ({ ...d, webUrl: `/deployments/${enc(String(d.id))}/` });

const managesDeployment = (c: WebCtx) => gateManageDeployment(c.res, c.user, c.params.id!);

export const runRoutes: readonly WebRoute[] = [
  route("GET", "/api/deployments", async ({ res, user }) => {
    const d = await coreJson<{ deployments?: Deployment[] }>(res, `/v1/deployments?principalId=${enc(user)}`);
    if (d) json(res, 200, { deployments: (d.deployments ?? []).map(withWebUrl) });
  }),
  route("GET", "/api/deployments/:id", async ({ res, user, params }) => {
    const id = params.id!;
    if (!id || id.includes("/")) return json(res, 404, { error: "not_found" });
    const d = await coreJson<{ deployment?: Deployment }>(res, `/v1/deployments/${enc(id)}?principalId=${enc(user)}`);
    if (!d) return;
    return d.deployment
      ? json(res, 200, { deployment: withWebUrl(d.deployment) })
      : json(res, 502, { error: "bad_core_response" });
  }),
  relayRoute("GET", "/api/deployments/:id/share", { cap: true }),
  relayRoute("POST", "/api/deployments/:id/share", {
    cap: true,
    pick: ["scope", "recipient", "email", "access", "public"],
    read: "strict",
  }),
  relayRoute("POST", "/api/deployments/:id/display-name", {
    gate: managesDeployment,
    read: "strict",
    shape: (p) => ({ displayName: String(p.displayName ?? "") }),
  }),
  relayRoute("POST", "/api/deployments/:id/name", {
    gate: managesDeployment,
    read: "strict",
    shape: (p) => ({ name: String(p.name ?? "") }),
  }),
  relayRoute("POST", "/api/deployments/:id/embed-ancestors", {
    gate: managesDeployment,
    read: "strict",
    shape: (p) => ({ embedAncestors: Array.isArray(p.embedAncestors) ? p.embedAncestors : [] }),
  }),
  relayRoute("POST", "/api/deployments/:id/archive", { gate: managesDeployment }),
  relayRoute("POST", "/api/deployments/:id/restore", { gate: managesDeployment, principal: true }),
  route("POST", "/api/approvals/:requestId", async (c) => {
    const { req, res, user } = c;
    const requestId = c.params.requestId!;
    if (!requestId || requestId.includes("/")) return json(res, 404, { error: "not_found" });
    const p = await readJson<{ approved?: unknown; scope?: unknown; idempotencyKey?: unknown }>(req, res, false);
    if (!p) return;
    if (typeof p.approved !== "boolean") return json(res, 400, { error: "bad_request" });
    const approved = p.approved;
    const scope = approvalScope(p.scope);
    const idempotencyKey = namespacedSendKey(user, p.idempotencyKey);

    const record = await coreJson<CoreApprovalRecord>(res, `/v1/approvals/${enc(requestId)}`);
    if (!record) return;
    const threadRef =
      typeof record.request?.conversation?.threadRef === "string" ? record.request.conversation.threadRef : "";
    const actor = typeof record.request?.actor?.externalId === "string" ? record.request.actor.externalId : "";
    const delegated = threadRef.startsWith(SUBAGENT_THREAD_PREFIX);
    if ((!threadRef.startsWith("web:") && !delegated) || actor !== user || !record.request) {
      return json(res, 404, { error: "not_found" });
    }
    if (/^web:.+:inbox$/.test(threadRef)) {
      const resolved = await resolveWebConversation(user, threadRef, undefined, undefined);
      if ("error" in resolved) return json(res, 403, resolved);
      if (record.request.conversation?.kind !== "dm") return json(res, 403, { error: "forbidden_scope" });
    }
    if (!threadRef.startsWith(`web:${user}:`)) {
      const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
      const visible = sessionId
        ? await coreFetch("GET", `/v1/sessions/${enc(sessionId)}?viewer=${enc(user)}&tailTurns=1`)
        : null;
      if (visible?.status !== 200) return json(res, 404, { error: "not_found" });
      if (delegated) {
        const session = (JSON.parse(visible.text) as { session?: { threadRef?: string } }).session;
        if (session?.threadRef !== threadRef) return json(res, 404, { error: "not_found" });
      }
    }

    const approval = { requestId, approved, ...(scope ? { scope } : {}) };
    const replay: Record<string, unknown> = { ...record.request, approval };
    delete replay.idempotencyKey;
    if (idempotencyKey) replay.idempotencyKey = idempotencyKey;
    return postTurnAndMint(req, res, replay);
  }),
  route("POST", "/api/turn", async (c) => {
    const { req, res, user } = c;
    let p: Record<string, any> = {};
    try {
      p = Object(JSON.parse(await readBody(req)));
    } catch (e) {
      if (e instanceof PayloadTooLargeError) throw e;
    }
    const text = String(p.text ?? "");
    const threadRef: string = isWebThread(p.threadRef) ? p.threadRef : `web:${user}:default`;
    const proactiveOpener = p.proactiveOpener === true;
    const a = p.approval;
    const approval =
      a && typeof a.requestId === "string" && typeof a.approved === "boolean"
        ? { requestId: a.requestId, approved: a.approved, ...(approvalScope(a.scope) ? { scope: a.scope } : {}) }
        : undefined;
    const attachments = (Array.isArray(p.attachments) ? p.attachments : []).flatMap((a: any) =>
      a && typeof a === "object" && typeof a.name === "string" && typeof a.blobId === "string" && a.blobId
        ? [
            {
              name: a.name,
              mimetype: typeof a.mimetype === "string" && a.mimetype ? a.mimetype : "application/octet-stream",
              sizeBytes: typeof a.sizeBytes === "number" ? a.sizeBytes : 0,
              blobId: a.blobId,
            },
          ]
        : [],
    );
    if (!text.trim() && attachments.length === 0 && !approval && !proactiveOpener)
      return json(res, 400, { error: "empty message" });

    const scope = typeof p.scopeId === "string" && p.scopeId ? p.scopeId : undefined;
    const resolved = await resolveWebConversation(user, threadRef, scope, channelLabel(p.channelName));
    if ("error" in resolved) return json(res, 403, resolved);

    const timezone = typeof p.timezone === "string" ? p.timezone.trim().slice(0, 64) : "";
    const idempotencyKey =
      namespacedSendKey(user, p.idempotencyKey) ??
      (typeof p.clientTurnId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.clientTurnId)
        ? `web:${user}:${p.clientTurnId}`
        : undefined);
    const turn = {
      ...(await webTurnBase(req, user, resolved.conversation, threadRef, text)),
      ...(typeof p.model === "string" && p.model ? { model: p.model } : {}),
      ...(typeof p.thinkingLevel === "string" && p.thinkingLevel ? { thinkingLevel: p.thinkingLevel } : {}),
      ...(typeof p.fastMode === "boolean" ? { fastMode: p.fastMode } : {}),
      ...(timezone ? { timezone } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(approval ? { approval } : {}),
      ...(proactiveOpener ? { proactiveOpener: true } : {}),
      ...(typeof p.desktopClientId === "string" && p.desktopClientId.length === 36 && !proactiveOpener
        ? { desktopClientId: p.desktopClientId }
        : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    return postTurnAndMint(req, res, turn);
  }),
  route("GET", "/api/session-events", async (c) => {
    const { req, res, user } = c;
    res.writeHead(200, SSE_HEADERS);
    res.write(": open\n\n");
    const clients = eventClients();
    let set = clients.get(user);
    if (!set) {
      set = new Set();
      clients.set(user, set);
    }
    set.add(res);
    const beat = setInterval(() => res.write(": ping\n\n"), SSE_HEARTBEAT_MS);
    beat.unref?.();
    req.on("close", () => {
      clearInterval(beat);
      const s = clients.get(user);
      if (s) {
        s.delete(res);
        if (!s.size) clients.delete(user);
      }
    });
    return;
  }),
  route("GET", "/api/runs/active", async (c) => {
    const { res, url } = c;
    const threadRef = url.searchParams.get("threadRef") ?? "";
    if (!isWebThread(threadRef)) return json(res, 404, { error: "not_found" });
    const durable = await coreFetch("GET", `/v1/runs?threadRef=${enc(threadRef)}`);
    type Queued = { runId: string; text: string; hasAttachments?: boolean };
    const parsed =
      durable.status >= 200 && durable.status < 300
        ? tryParse<{ runId?: string | null; queued?: Queued[] } | null>(durable.text)
        : undefined;
    const queued = parsed?.queued ?? [];
    const runId = parsed?.runId;
    if (runId) {
      const r = await coreFetch("GET", `/v1/runs/${enc(runId)}`);
      if (r.status >= 200 && r.status < 300) {
        const run = tryParse<{ status?: string }>(r.text);
        if (!run) return json(res, 502, { error: "bad_core_response" });
        if (run.status !== "done" && run.status !== "failed") {
          const waiting = queued.filter((q) => q.runId !== runId);
          return json(res, 200, { runId, run, ...(waiting.length ? { queued: waiting } : {}) });
        }
      }
    }
    json(res, 200, { runId: null, run: null, ...(queued.length ? { queued } : {}) });
    return;
  }),
  route("POST", "/api/runs/:id/signal", async (c) => {
    const { req, res, user } = c;
    const id = c.params.id!;
    const p = await readJson<Record<string, unknown>>(req, res, false, 6_000_000);
    if (!p) return;
    const kind = typeof p.kind === "string" ? p.kind : "";
    const text = typeof p.text === "string" ? p.text : undefined;
    const threadRef = isWebThread(p.threadRef) ? p.threadRef : "";
    let steerFields: { request: Awaited<ReturnType<typeof webTurnBase>> } | undefined;
    if (kind === "steer" && text !== undefined && threadRef) {
      const scope = typeof p.scopeId === "string" && p.scopeId ? p.scopeId : undefined;
      const resolved = await resolveWebConversation(user, threadRef, scope, channelLabel(p.channelName));
      if ("error" in resolved) return json(res, 403, resolved);
      steerFields = { request: await webTurnBase(req, user, resolved.conversation, threadRef, text) };
    }
    return relayCore(
      res,
      "POST",
      `/v1/runs/${enc(id)}/signal`,
      JSON.stringify({
        kind,
        ...(kind === "client_result" ? { callId: p.callId, result: p.result, desktopClientId: p.desktopClientId } : {}),
        ...(text !== undefined ? { text } : {}),
        ...steerFields,
        ...(typeof p.queuedRunId === "string" ? { queuedRunId: p.queuedRunId } : {}),
      }),
    );
  }),
  relayRoute("PATCH", "/api/runs/:id/input", { read: "strict" }),
  relayRoute("POST", "/api/runs/:id/withdraw"),
  route("GET", "/api/runs/:id/events", async (c) => {
    const { res } = c;
    const id = c.params.id!;
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try {
      const upstream = await fetchCoreGet(`/v1/runs/${enc(id)}/events`, {
        signal: controller.signal,
        redirect: "manual",
      });
      if (controller.signal.aborted) return;
      if (!upstream.ok || !upstream.body) {
        json(res, upstream.status, { error: "stream_unavailable" });
        return;
      }
      res.writeHead(200, SSE_HEADERS);
      pipeWeb(res, upstream.body);
    } catch {
      if (!controller.signal.aborted) {
        if (res.headersSent) res.destroy();
        else json(res, 502, { error: "stream_unavailable" });
      }
    }
  }),
  relayRoute("GET", "/api/runs/:id"),
  relayRoute("GET", "/api/inbox/sent/:messageId", {
    core: "/v1/connectors/gmail/sent/:messageId",
    query: (c) => copyParams(c, ["accountType"], {}),
    noStore: true,
  }),
  relayRoute("GET", "/api/inbox/sent", {
    core: "/v1/connectors/gmail/sent",
    query: (c) => copyParams(c, ["pageToken", "accountType"], {}),
    noStore: true,
  }),
  relayRoute("GET", "/api/webhooks", { who: "viewer" }),
  relayRoute("GET", "/api/webhooks/:id/events", { who: "viewer" }),
  route("POST", "/api/webhooks", async (c) => {
    const { req, res, user } = c;
    const bad = (error: string, message: string) => json(res, 400, { error, message });
    const p = tryParse<Record<string, any> | null>(await readBody(req));
    if (p == null) return bad("bad_request", "expected JSON body");
    const action = String(p.action ?? "").trim();
    const v = p.verification;
    if (p.destination !== undefined)
      return bad(
        "invalid_destination",
        "choose webhook destinations with the agent so teammate and channel names can be resolved safely",
      );
    if (!action) return bad("action_required", "an action (the agent's instructions) is required");
    const reqBody = JSON.stringify({
      ownerScopeId: `personal:${user}`,
      owner: user,
      createdBy: user,
      action,
      verification: {
        scheme: v === undefined ? "hmac-sha256" : v.scheme,
        secret: v?.secret ? String(v.secret) : randomBytes(32).toString("hex"),
      },
      ...(p.filters !== undefined ? { filters: p.filters } : {}),
    });
    return relayCore(res, "POST", "/v1/webhooks", reqBody);
  }),
  ...["disable", "enable"].map((verb) =>
    relayRoute("POST", `/api/webhooks/:id/${verb}`, {
      who: "principalId",
      gate: async ({ res, user, params }) => {
        const r = await coreFetch("GET", `/v1/webhooks?viewer=${enc(user)}`);
        if (r.status < 200 || r.status >= 300) return (relay(res, r), false);
        const webhooks = tryParse<{ webhooks?: Array<{ id?: unknown }> }>(r.text)?.webhooks ?? [];
        return webhooks.some((w) => w.id === params.id) || (json(res, 404, { error: "not_found" }), false);
      },
    }),
  ),
  route("GET", "/api/crons", async ({ res, user }) => {
    const r = await coreFetch("GET", `/v1/crons?viewer=${enc(user)}`);
    if (r.status < 200 || r.status >= 300) return relay(res, r);
    const parsed = tryParse<{ crons?: unknown[]; visible?: unknown[] } | null>(r.text);
    return json(res, 200, { crons: parsed?.crons ?? [], visible: parsed?.visible ?? [] });
  }),
  relayRoute("GET", "/api/crons/:id/runs", { query: (c) => ({ principalId: c.user, limit: "20" }) }),
  relayRoute("PATCH", "/api/crons/:id", {
    who: "principalId",
    read: "strict",
    pick: ["runtime", "title", "task", "schedule", "enabled", "archived"],
  }),
  relayRoute("POST", "/api/crons/:id/disable", { who: "principalId" }),
  relayRoute("POST", "/api/crons/:id/enable", {
    core: "/v1/crons/:id",
    to: "PATCH",
    who: "principalId",
    body: { enabled: true, archived: false },
  }),
  relayRoute("POST", "/api/crons/:id/run", { who: "principalId" }),
  relayRoute("DELETE", "/api/crons/:id", { who: "principalId" }),
];
