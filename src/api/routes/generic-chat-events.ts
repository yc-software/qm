import { SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../../surfaces/generic-chat/protocol.ts";
import { headerValue, PayloadTooLargeError, readRawBody, sendJson } from "../http.ts";
import type { BaseCtx, Route } from "./route.ts";

type Reply = { status: number; body: Record<string, unknown> };

function hostEvents(
  handler: (ctx: BaseCtx) => ((rawBody: string) => Promise<Reply>) | undefined,
): (ctx: BaseCtx) => Promise<void> {
  return async (ctx) => {
    const { req, res } = ctx;
    const handle = handler(ctx);
    if (!handle) {
      req.resume();
      return sendJson(res, 404, { error: "not_found" });
    }
    let rawBody: string;
    try {
      rawBody = await readRawBody(req);
    } catch (e) {
      if (e instanceof PayloadTooLargeError) return sendJson(res, 413, { error: "payload_too_large" });
      throw e;
    }
    const out = await handle(rawBody);
    return sendJson(res, out.status, out.body);
  };
}

const genericChatEvents = hostEvents(({ req, deps }) => {
  const handle = deps.genericChatEvents;
  return handle && ((raw) => handle(headerValue(req, TIMESTAMP_HEADER), headerValue(req, SIGNATURE_HEADER), raw));
});

const teamsActivities = hostEvents(({ req, deps }) => {
  const handle = deps.teamsActivities;
  return handle && ((raw) => handle(headerValue(req, "authorization"), raw));
});

export const genericChatEventRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  {
    method: "POST",
    path: "/v1/surfaces/generic-chat/events",
    auth: "public",
    tenant: "none",
    handle: genericChatEvents,
  },
  {
    method: "POST",
    path: "/v1/surfaces/teams/activities",
    auth: "public",
    tenant: "none",
    handle: teamsActivities,
  },
];
