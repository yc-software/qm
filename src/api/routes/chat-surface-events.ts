import { errMessage } from "../../util/errors.ts";
import { PayloadTooLargeError, readRawBody, sendJson } from "../http.ts";
import type { BaseCtx, Route } from "./route.ts";

async function surfaceEvents(ctx: BaseCtx): Promise<void> {
  const { req, res, deps, params, url } = ctx;
  if (!deps.chatSurfaces) {
    req.resume();
    return sendJson(res, 404, { error: "not_found" });
  }
  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    if (e instanceof PayloadTooLargeError)
      return sendJson(res, 413, { error: "payload_too_large", message: errMessage(e) });
    throw e;
  }
  const out = await deps.chatSurfaces.receive(params.surface!, {
    headers: req.headers,
    pathWithQuery: url.pathname + url.search,
    rawBody,
  });
  return sendJson(res, out.status, out.body);
}

export const chatSurfaceRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "POST", path: "/v1/surfaces/:surface/events", auth: "public", handle: surfaceEvents },
];
