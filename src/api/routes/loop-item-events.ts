import type { BaseCtx, Route } from "./route.ts";
import { canonicalPayload, verifyOrReject } from "../http.ts";

const HEARTBEAT_MS = 25_000;

async function streamLoopItemEvents(ctx: BaseCtx): Promise<void> {
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
  const unsubscribe = app.subscribeLedgerEvents(
    (event) => {
      res.write(`event: loop_item\ndata: ${JSON.stringify(event)}\n\n`);
    },
    { onResync: () => res.write("event: loop_item_resync\ndata: {}\n\n") },
  );
  const beat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  beat.unref?.();
  req.on("close", () => {
    clearInterval(beat);
    unsubscribe();
  });
}

export const loopItemEventsRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "GET", path: "/v1/loop-items/events", auth: "source", handle: streamLoopItemEvents },
];
