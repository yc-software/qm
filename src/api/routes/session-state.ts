import type { BaseCtx, Route } from "./route.ts";
import { canonicalPayload, verifyOrReject } from "../http.ts";

const HEARTBEAT_MS = 25_000;

async function streamSessionStates(ctx: BaseCtx): Promise<void> {
  const { req, res, app, secret, auth, url, pathname, method } = ctx;
  if (
    !(await verifyOrReject(
      req,
      res,
      secret,
      auth,
      canonicalPayload(method, pathname + url.search, ""),
      false,
      ctx.allowUnsignedSourceAuth,
    ))
  ) {
    req.resume();
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": open\n\n");
  const unsubscribe = app.subscribeSessionStates((event) => {
    res.write(`event: session_state\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const beat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  beat.unref?.();
  req.on("close", () => {
    clearInterval(beat);
    unsubscribe();
  });
}

export const sessionStateRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "GET", path: "/v1/session-state/events", auth: "source", handle: streamSessionStates },
];
