import { webNotificationsOn, type WebPush } from "../../notifications/web-push.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";
import { isObj } from "./shared.ts";

async function webPushFor(ctx: ApiCtx): Promise<{ push: WebPush; person: string } | null> {
  const push = ctx.deps.webPush;
  if (push && ctx.actor && (await webNotificationsOn(ctx.deps, ctx.actor.p))) return { push, person: ctx.actor.p };
  sendJson(ctx.res, 404, { error: "not_found" });
  return null;
}

function httpsEndpoint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

async function vapidKey(ctx: ApiCtx): Promise<void> {
  const found = await webPushFor(ctx);
  if (found) sendJson(ctx.res, 200, { publicKey: await found.push.publicKey() });
}

async function putSubscription(ctx: ApiCtx): Promise<void> {
  const found = await webPushFor(ctx);
  if (!found) return;
  if (ctx.actor?.imp)
    return sendJson(ctx.res, 403, {
      error: "forbidden",
      message: "push notifications can't be turned on while impersonating",
    });
  const body = isObj(ctx.body) ? ctx.body : {};
  const keys = isObj(body.keys) ? body.keys : {};
  const endpoint = httpsEndpoint(body.endpoint);
  if (!endpoint || typeof keys.p256dh !== "string" || typeof keys.auth !== "string")
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "pass the browser's PushSubscription JSON: an https endpoint and keys.p256dh and keys.auth",
    });
  await found.push.subscribe(found.person, { endpoint, p256dh: keys.p256dh, auth: keys.auth });
  sendJson(ctx.res, 200, { ok: true });
}

async function deleteSubscription(ctx: ApiCtx): Promise<void> {
  const found = await webPushFor(ctx);
  if (!found) return;
  const endpoint = httpsEndpoint(ctx.url.searchParams.get("endpoint"));
  if (!endpoint)
    return sendJson(ctx.res, 400, { error: "bad_request", message: "pass the subscription's https endpoint" });
  await found.push.unsubscribe(found.person, endpoint);
  sendJson(ctx.res, 200, { ok: true });
}

export const webPushRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/web/push", browser: true, actor: "person", auth: "source", handle: vapidKey },
  {
    method: "PUT",
    path: "/v1/web/push/subscription",
    browser: true,
    actor: "person",
    auth: "source",
    handle: putSubscription,
  },
  {
    method: "DELETE",
    path: "/v1/web/push/subscription",
    browser: true,
    actor: "person",
    auth: "source",
    handle: deleteSubscription,
  },
];
