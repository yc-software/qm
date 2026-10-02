import type { BaseCtx, Route } from "./route.ts";
import { canonicalPayload, verifyOrReject } from "../http.ts";
import { openSseStream, sseFrame } from "../../../plugins/chassis/src/sse.ts";

const HEARTBEAT_MS = 25_000;

type Subscribe = (app: BaseCtx["app"], onEvent: (event: unknown) => void, opts: { onResync: () => void }) => () => void;

function feedRoute(path: string, event: string, subscribe: Subscribe): Route<BaseCtx> {
  const handle = async (ctx: BaseCtx): Promise<void> => {
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
    openSseStream(req, res, HEARTBEAT_MS, () =>
      subscribe(app, (data) => res.write(sseFrame(data, { event })), {
        onResync: () => res.write(sseFrame({}, { event: `${event}_resync` })),
      }),
    );
  };
  return { method: "GET", path, auth: "source", handle };
}

export const eventFeedRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  feedRoute("/v1/session-state/events", "session_state", (app, fn, opts) => app.subscribeSessionStates(fn, opts)),
  feedRoute("/v1/loop-items/events", "loop_item", (app, fn, opts) => app.subscribeLedgerEvents(fn, opts)),
];
