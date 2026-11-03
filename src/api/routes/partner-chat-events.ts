import { headerValue, PayloadTooLargeError, readRawBody, sendJson } from "../http.ts";
import type { BaseCtx, Route } from "./route.ts";

async function partnerChatEvents(ctx: BaseCtx): Promise<void> {
  const { req, res, deps } = ctx;
  if (!deps.partnerChatEvents) {
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
  const out = await deps.partnerChatEvents(
    headerValue(req, "x-qm-timestamp"),
    headerValue(req, "x-qm-signature"),
    rawBody,
  );
  return sendJson(res, out.status, out.body);
}

export const partnerChatEventRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "POST", path: "/v1/surfaces/partner-chat/events", auth: "public", handle: partnerChatEvents },
];
