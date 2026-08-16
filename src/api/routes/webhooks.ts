import type { Webhook } from "../../types.ts";
import { WEBHOOK_SCHEMES } from "../../webhooks/verifiers.ts";
import type { CreateWebhookInput } from "../../webhooks/webhook-store.ts";
import { errMessage } from "../../util/errors.ts";
import { canAdministerWebhook } from "../control-service.ts";
import { PayloadTooLargeError, readRawBody, sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, BaseCtx, Route } from "./route.ts";

function isCreateWebhook(b: unknown): b is CreateWebhookInput {
  if (!isObj(b)) return false;
  const v = b.verification;
  return (
    typeof b.ownerScopeId === "string" &&
    typeof b.owner === "string" &&
    typeof b.createdBy === "string" &&
    typeof b.action === "string" &&
    isObj(v) &&
    isWebhookVerification(v) &&
    (b.filters === undefined || isWebhookFilters(b.filters)) &&
    (b.destination === undefined || isObj(b.destination))
  );
}

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
  unknown_destination: 400,
  webhook_create_failed: 400,
};

async function createWebhook(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, body, capability } = ctx;
  if (capability) {
    const b = body as { verification?: unknown; action?: unknown; filters?: unknown; destinationKey?: unknown };
    const ver = isObj(b.verification) ? (b.verification as { scheme?: unknown; secret?: unknown }) : undefined;
    if (!ver || !isWebhookVerification(ver) || typeof b.action !== "string") {
      return sendJson(res, 400, {
        error: "bad_request",
        message: "a supported signature scheme and non-empty signing secret are required",
      });
    }
    if (b.filters !== undefined && !isWebhookFilters(b.filters)) {
      return sendJson(res, 400, {
        error: "bad_request",
        message: "every filter requires a non-empty path and at least one non-empty value",
      });
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
  if (!isCreateWebhook(body))
    return sendJson(res, 400, { error: "bad_request", message: "expected a CreateWebhookInput" });
  try {
    const webhook = await app.createWebhook(body);
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
  const isViewer = viewer ? await app.personMatcher(viewer) : undefined;
  const allowed = viewer
    ? await Promise.all(all.map((webhook) => canAdministerWebhook(app, webhook, viewer, isViewer)))
    : all.map(() => true);
  const visible = all.filter((_webhook, index) => allowed[index]);
  return sendJson(res, 200, {
    webhooks: visible.map((webhook) => ({ ...redactWebhook(webhook), url: inboundUrl(deps.publicUrl, webhook.id) })),
  });
}

async function setWebhookEnabled(ctx: ApiCtx, enabled: boolean): Promise<void> {
  const { res, app, params, capability, actor, url } = ctx;
  const id = params.id!;
  const webhook = await app.getWebhook(id);
  if (!webhook) return sendJson(res, 404, { error: "not_found" });
  const principalId = capability?.actorId ?? actor?.p ?? url.searchParams.get("principalId");
  if (principalId && !(await canAdministerWebhook(app, webhook, principalId))) {
    const portalCaller = Boolean(capability || actor);
    return sendJson(res, portalCaller ? 403 : 404, {
      error: portalCaller ? "forbidden" : "not_found",
      ...(portalCaller ? { message: "not your webhook" } : {}),
    });
  }
  await app.setWebhookEnabled(id, enabled);
  return sendJson(res, 200, { ok: true });
}

const disableWebhook = (ctx: ApiCtx): Promise<void> => setWebhookEnabled(ctx, false);
const enableWebhook = (ctx: ApiCtx): Promise<void> => setWebhookEnabled(ctx, true);

export const webhookRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "POST", path: "/v1/webhooks/incoming/:id", auth: "public", handle: incomingWebhook },
];

export const webhookRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/webhooks", auth: "either", handle: createWebhook },
  { method: "GET", path: "/v1/webhooks", auth: "either", handle: listWebhooks },
  { method: "POST", path: "/v1/webhooks/:id/disable", auth: "either", handle: disableWebhook },
  { method: "POST", path: "/v1/webhooks/:id/enable", auth: "either", handle: enableWebhook },
];
