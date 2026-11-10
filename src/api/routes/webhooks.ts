import { randomBytes } from "node:crypto";
import type { Webhook } from "../../triggers/types.ts";
import { WEBHOOK_SCHEMES } from "../../webhooks/verifiers.ts";
import type { CreateWebhookInput } from "../../webhooks/webhook-store.ts";
import { errMessage } from "../../util/errors.ts";
import { canAdministerWebhook, editWebhookTask } from "../control-service.ts";
import { PayloadTooLargeError, readRawBody, sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, BaseCtx, Route } from "./route.ts";

const FILTERS_MESSAGE = "every filter requires a non-empty path and at least one non-empty value";
const VERIFICATION_MESSAGE = "a supported signature scheme and non-empty signing secret are required";

function isWebhookVerification(value: Record<string, unknown>): boolean {
  return (
    typeof value.scheme === "string" &&
    (WEBHOOK_SCHEMES as readonly string[]).includes(value.scheme) &&
    typeof value.secret === "string" &&
    value.secret.length > 0
  );
}

function isWebhookFilters(value: unknown): value is Webhook["filters"] {
  return (
    Array.isArray(value) &&
    value.every(
      (filter) =>
        isObj(filter) &&
        typeof filter.path === "string" &&
        filter.path.trim().length > 0 &&
        Array.isArray(filter.in) &&
        filter.in.length > 0 &&
        filter.in.every((candidate) => typeof candidate === "string" && candidate.trim().length > 0),
    )
  );
}

export function redactWebhook(w: Webhook): Webhook {
  if (!w.verification.secret) return w;
  return { ...w, verification: { ...w.verification, secret: "***" } };
}

async function incomingWebhook(ctx: BaseCtx): Promise<void> {
  const { req, res, deps, params } = ctx;
  if (!deps.webhookReceiver) {
    req.resume();
    return sendJson(res, 404, { error: "not_found" });
  }
  const id = params.id!;
  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    if (e instanceof PayloadTooLargeError)
      return sendJson(res, 413, { error: "payload_too_large", message: errMessage(e) });
    throw e;
  }
  const out = await deps.webhookReceiver.deliver(id, { headers: req.headers, rawBody });
  if (out.status === 200) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(out.body);
    return;
  }
  if (out.status === 202) return sendJson(res, 202, { ok: true });
  if (out.status === 401)
    return sendJson(res, 401, { error: "unauthorized", message: "signature verification failed" });
  return sendJson(res, 404, { error: "not_found" });
}

const WEBHOOK_ERROR_STATUS: Record<string, number> = {
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  unknown_destination: 400,
  webhook_create_failed: 400,
};

function personWebhook(body: unknown, owner: string): CreateWebhookInput | { error: string; message: string } {
  if (!isObj(body)) return { error: "bad_request", message: "expected JSON body" };
  const v = body.verification;
  if (v !== undefined && (!isObj(v) || typeof v.scheme !== "string"))
    return { error: "unsupported_verification", message: "verification requires a scheme" };
  if (body.filters !== undefined && !isWebhookFilters(body.filters))
    return { error: "invalid_filters", message: FILTERS_MESSAGE };
  if (body.destination !== undefined)
    return {
      error: "invalid_destination",
      message: "choose webhook destinations with the agent so teammate and channel names can be resolved safely",
    };
  const action = String(body.action ?? "").trim();
  if (!action) return { error: "action_required", message: "an action (the agent's instructions) is required" };
  const verification = {
    scheme: isObj(v) ? v.scheme : "hmac-sha256",
    secret: isObj(v) && v.secret ? String(v.secret) : randomBytes(32).toString("hex"),
  };
  if (!isWebhookVerification(verification)) return { error: "bad_request", message: VERIFICATION_MESSAGE };
  return {
    ownerScopeId: `personal:${owner}`,
    owner,
    createdBy: owner,
    action,
    verification: verification as Webhook["verification"],
    ...(body.filters ? { filters: body.filters as Webhook["filters"] } : {}),
  };
}

async function createWebhook(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, body, capability } = ctx;
  if (capability) {
    const b = body as { verification?: unknown; action?: unknown; filters?: unknown; destinationKey?: unknown };
    const ver = isObj(b.verification) ? (b.verification as { scheme?: unknown; secret?: unknown }) : undefined;
    if (!ver || !isWebhookVerification(ver) || typeof b.action !== "string") {
      return sendJson(res, 400, { error: "bad_request", message: VERIFICATION_MESSAGE });
    }
    if (b.filters !== undefined && !isWebhookFilters(b.filters)) {
      return sendJson(res, 400, { error: "bad_request", message: FILTERS_MESSAGE });
    }
    const result = await deps.control.createWebhook(
      {
        action: b.action,
        verification: { scheme: ver.scheme as Webhook["verification"]["scheme"], secret: ver.secret as string },
        ...(Array.isArray(b.filters) ? { filters: b.filters as Webhook["filters"] } : {}),
        ...(typeof b.destinationKey === "string" ? { destinationKey: b.destinationKey } : {}),
      },
      capability,
      deps.publicUrl,
    );
    if (!result.ok)
      return sendJson(res, WEBHOOK_ERROR_STATUS[result.code] ?? 400, { error: result.code, message: result.message });
    return sendJson(res, 200, { webhook: result.webhook, url: result.url });
  }
  const owner = ctx.actor?.p;
  if (!owner) return sendJson(res, 401, { error: "unauthorized", message: "portal identity required" });
  const input = personWebhook(body, owner);
  if ("error" in input) return sendJson(res, 400, input);
  try {
    const webhook = await app.createWebhook(input);
    return sendJson(res, 200, { webhook, url: inboundUrl(deps.publicUrl, webhook.id) });
  } catch (e) {
    return sendJson(res, 400, { error: "webhook_create_failed", message: errMessage(e) });
  }
}

function inboundUrl(publicBase: string | undefined, id: string): string {
  const incomingPath = `/v1/webhooks/incoming/${id}`;
  return publicBase ? `${publicBase.replace(/\/$/, "")}${incomingPath}` : incomingPath;
}

async function listWebhooks(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, capability, actor, url } = ctx;
  const all = await app.listWebhooks();
  const viewer = capability?.actorId ?? actor?.p ?? url.searchParams.get("viewer");
  if (!viewer) return sendJson(res, 400, { error: "bad_request", message: "viewer required" });
  const isViewer = await app.personMatcher(viewer);
  const allowed = await Promise.all(
    all.map((webhook) => canAdministerWebhook(app, webhook, capability ?? { actorId: viewer }, isViewer)),
  );
  const visible = all.filter((_webhook, index) => allowed[index]);
  return sendJson(res, 200, {
    webhooks: visible.map((webhook) => ({ ...redactWebhook(webhook), url: inboundUrl(deps.publicUrl, webhook.id) })),
  });
}

async function listWebhookEvents(ctx: ApiCtx): Promise<void> {
  const { res, app, params, capability, actor, url } = ctx;
  const webhook = await app.getWebhook(params.id!);
  const viewer = capability?.actorId ?? actor?.p ?? url.searchParams.get("viewer");
  if (!viewer || !webhook || !(await canAdministerWebhook(app, webhook, capability ?? { actorId: viewer }))) {
    return sendJson(res, 404, { error: "not_found" });
  }
  return sendJson(res, 200, { events: await app.listWebhookEvents(webhook.id, viewer) });
}

async function setWebhookEnabled(ctx: ApiCtx, enabled: boolean): Promise<void> {
  const { res, app, params, capability, actor, url } = ctx;
  const id = params.id!;
  const webhook = await app.getWebhook(id);
  if (!webhook) return sendJson(res, 404, { error: "not_found" });
  const principalId = capability?.actorId ?? actor?.p ?? url.searchParams.get("principalId");
  if (!principalId) return sendJson(res, 404, { error: "not_found" });
  if (!(await canAdministerWebhook(app, webhook, capability ?? { actorId: principalId }))) {
    return sendJson(res, capability ? 403 : 404, {
      error: capability ? "forbidden" : "not_found",
      ...(capability ? { message: "not your webhook" } : {}),
    });
  }
  await app.setWebhookEnabled(id, enabled);
  return sendJson(res, 200, { ok: true });
}

async function updateWebhook(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, params, capability, actor, url, body } = ctx;
  const action = isObj(body) && typeof body.action === "string" ? body.action : "";
  const principalId = actor?.p ?? url.searchParams.get("principalId");
  if (!capability && !principalId) return sendJson(res, 404, { error: "not_found" });
  const r = capability
    ? await deps.control.updateWebhook(params.id!, { action }, capability)
    : await editWebhookTask(app, params.id!, action, principalId!);
  if (!r.ok) return sendJson(res, WEBHOOK_ERROR_STATUS[r.code] ?? 400, { error: r.code, message: r.message });
  return sendJson(res, 200, { webhook: redactWebhook(r.webhook), url: inboundUrl(deps.publicUrl, r.webhook.id) });
}

const disableWebhook = (ctx: ApiCtx): Promise<void> => setWebhookEnabled(ctx, false);
const enableWebhook = (ctx: ApiCtx): Promise<void> => setWebhookEnabled(ctx, true);

export const webhookRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  {
    method: "POST",
    path: "/v1/webhooks/incoming/:id",
    auth: "public",
    tenant: { by: "webhook", key: (params) => params.id },
    handle: incomingWebhook,
  },
];

export const webhookRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/webhooks", browser: true, actor: "person", auth: "either", handle: createWebhook },
  { method: "GET", path: "/v1/webhooks", browser: true, actor: "query.viewer", auth: "either", handle: listWebhooks },
  {
    method: "GET",
    path: "/v1/webhooks/:id/events",
    browser: true,
    actor: "query.viewer",
    auth: "either",
    handle: listWebhookEvents,
  },
  {
    method: "POST",
    path: "/v1/webhooks/:id/update",
    actor: "query.principalId",
    auth: "either",
    handle: updateWebhook,
  },
  {
    method: "POST",
    path: "/v1/webhooks/:id/disable",
    browser: true,
    actor: "query.principalId",
    auth: "either",
    handle: disableWebhook,
  },
  {
    method: "POST",
    path: "/v1/webhooks/:id/enable",
    browser: true,
    actor: "query.principalId",
    auth: "either",
    handle: enableWebhook,
  },
];
