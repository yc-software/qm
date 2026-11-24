import { z } from "zod";
import { answerDesktopCall, claimDesktopCall } from "../../surfaces/desktop-calls.ts";
import { refuseImpersonated, sendJson } from "../http.ts";
import { CLIENT_RESULT_MAX_BODY_BYTES, clientResultSchema, zodMessage } from "./turns.ts";
import type { ApiCtx, Route } from "./route.ts";

const claimSchema = z.object({ desktopClientId: z.uuid() });
const resultSchema = claimSchema.extend({ result: clientResultSchema.shape.result });

async function claim(ctx: ApiCtx): Promise<void> {
  const user = ctx.actor?.p;
  if (!user) return sendJson(ctx.res, 401, { error: "unauthorized" });
  if (ctx.actor?.imp) return refuseImpersonated(ctx.res);
  if (!ctx.deps.uiState) return sendJson(ctx.res, 503, { error: "not_available" });
  const parsed = claimSchema.safeParse(ctx.body);
  if (!parsed.success)
    return sendJson(ctx.res, 400, { error: "bad_request", message: zodMessage("claim", parsed.error) });
  const call = await claimDesktopCall(ctx.deps.uiState, user, ctx.params.callId!, parsed.data.desktopClientId);
  return call ? sendJson(ctx.res, 200, call) : sendJson(ctx.res, 404, { error: "not_found" });
}

async function result(ctx: ApiCtx): Promise<void> {
  const user = ctx.actor?.p;
  if (!user) return sendJson(ctx.res, 401, { error: "unauthorized" });
  if (ctx.actor?.imp) return refuseImpersonated(ctx.res);
  const { uiState, signals } = ctx.deps;
  if (!uiState || !signals) return sendJson(ctx.res, 503, { error: "not_available" });
  const parsed = resultSchema.safeParse(ctx.body);
  if (!parsed.success)
    return sendJson(ctx.res, 400, { error: "bad_request", message: zodMessage("result", parsed.error) });
  const { desktopClientId, result } = parsed.data;
  const sent = await answerDesktopCall({ uiState, signals }, user, ctx.params.callId!, desktopClientId, result);
  return sent ? sendJson(ctx.res, 200, { ok: true }) : sendJson(ctx.res, 404, { error: "not_found" });
}

export const desktopCallRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "POST",
    path: "/v1/web/desktop/calls/:callId/claim",
    browser: "embed",
    actor: "person",
    auth: "source",
    handle: claim,
  },
  {
    method: "POST",
    path: "/v1/web/desktop/calls/:callId/result",
    browser: "embed",
    actor: "person",
    auth: "source",
    maxBodyBytes: CLIENT_RESULT_MAX_BODY_BYTES,
    handle: result,
  },
];
