import { ChatCompletionError, completeChatRequest } from "../../model/chat-completion.ts";
import { routeLabel, type ModelRoute } from "../../model/model-route.ts";
import { errMessage, reportFailure } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx } from "./route.ts";

export async function respondChatCompletion(
  ctx: ApiCtx,
  route: ModelRoute,
  input: Record<string, unknown>,
  purpose: "browser" | "sandbox",
  errorBody: (message: string) => unknown,
  timeoutMs?: number,
): Promise<Awaited<ReturnType<typeof completeChatRequest>> | undefined> {
  const { res } = ctx;
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once("close", abort);
  try {
    const signal = timeoutMs ? AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]) : controller.signal;
    const result = await completeChatRequest(route, input, signal, purpose);
    sendJson(res, 200, result);
    return result;
  } catch (error) {
    if (controller.signal.aborted) return undefined;
    const detail = `${ctx.pathname} ${routeLabel(route)}`;
    if (error instanceof ChatCompletionError) {
      if (error.status >= 500) reportFailure(`${purpose} model request`, error, detail);
      if (!res.destroyed) sendJson(res, error.status, errorBody(error.message));
    } else {
      reportFailure(`${purpose} model request`, error, detail);
      if (!res.destroyed)
        sendJson(
          res,
          502,
          errorBody(`${routeLabel(route)} could not complete the ${purpose} request: ${errMessage(error)}`),
        );
    }
    return undefined;
  } finally {
    res.off("close", abort);
  }
}
