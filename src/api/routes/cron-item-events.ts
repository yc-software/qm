import type { BaseCtx, Route } from "./route.ts";
import { canonicalPayload } from "../../../plugins/chassis/src/source-auth-sign.ts";
import { verifyOrReject } from "../http.ts";

const HEARTBEAT_MS = 25_000;

async function streamInboxItemEvents(ctx: BaseCtx): Promise<void> {
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
      res.write(`event: inbox_item\ndata: ${JSON.stringify(event)}\n\n`);
    },
    { onResync: () => res.write("event: inbox_item_resync\ndata: {}\n\n") },
  );
  const beat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  beat.unref?.();
  req.on("close", () => {
    clearInterval(beat);
    unsubscribe();
  });
}

export const cronItemEventsRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "GET", path: "/v1/cron-items/events", auth: "source", handle: streamInboxItemEvents },
];
