import { request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import { sendJson } from "../http.ts";
import type { BaseCtx, Route } from "./route.ts";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function receiverPort(port: number | undefined): number | null {
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())));
}

async function proxySlackEvents(ctx: BaseCtx): Promise<void> {
  const port = receiverPort(ctx.deps.slackEventsPort);
  if (!port) {
    sendJson(ctx.res, 404, { error: "not_found" });
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const headers: OutgoingHttpHeaders = { ...ctx.req.headers, host: `127.0.0.1:${port}` };
    for (const name of HOP_BY_HOP) delete headers[name];
    const upstream = request(
      {
        host: "127.0.0.1",
        port,
        method: ctx.method,
        path: ctx.req.url ?? "/slack/events",
        headers,
      },
      (upstreamRes) => {
        ctx.res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders(upstreamRes.headers));
        upstreamRes.pipe(ctx.res);
        upstreamRes.once("end", finish);
        upstreamRes.once("error", (error) => {
          ctx.res.destroy(error);
          finish();
        });
      },
    );
    upstream.once("error", () => {
      if (!ctx.res.headersSent) sendJson(ctx.res, 503, { error: "slack_events_unavailable" });
      else ctx.res.destroy();
      finish();
    });
    ctx.req.once("aborted", () => {
      upstream.destroy();
      finish();
    });
    ctx.req.pipe(upstream);
  });
}

export const slackEventRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "POST", path: "/slack/events", auth: "public", handle: proxySlackEvents },
];
