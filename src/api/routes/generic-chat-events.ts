import { SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../../surfaces/generic-chat/protocol.ts";
import { headerValue, PayloadTooLargeError, readRawBody, sendJson } from "../http.ts";
import type { BaseCtx, Route } from "./route.ts";

async function genericChatEvents(ctx: BaseCtx): Promise<void> {
  const { req, res, deps } = ctx;
  if (!deps.genericChatEvents) {
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
  const out = await deps.genericChatEvents(
    headerValue(req, TIMESTAMP_HEADER),
    headerValue(req, SIGNATURE_HEADER),
    rawBody,
  );
  return sendJson(res, out.status, out.body);
}

export const genericChatEventRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  {
    method: "POST",
    path: "/v1/surfaces/generic-chat/events",
    auth: "public",
    tenant: "none",
    handle: genericChatEvents,
  },
];
