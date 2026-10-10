import type { IncomingMessage, ServerResponse } from "node:http";

interface CoreReply {
  status: number;
  text: string;
}

interface UiCanvasCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  user: string;
  params: Record<string, string>;
}

interface UiCanvasRouteDeps {
  impersonated: (req: IncomingMessage) => boolean;
  coreFetch: (method: "GET", pathWithQuery: string) => Promise<CoreReply>;
  relayCore: (res: ServerResponse, method: "GET" | "POST", pathWithQuery: string, rawBody?: string) => Promise<void>;
  relay: (res: ServerResponse, r: CoreReply) => void;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readJson: <T extends object>(req: IncomingMessage, res: ServerResponse, allowEmpty?: boolean) => Promise<T | null>;
}

const canvasPath = (sessionId: string, user: string) =>
  `/v1/ui/canvases/${encodeURIComponent(sessionId)}?${new URLSearchParams({ principalId: user }).toString()}`;

export function uiCanvasRoutes(d: UiCanvasRouteDeps) {
  const guard = (c: UiCanvasCtx) => {
    if (!d.impersonated(c.req)) return false;
    d.json(c.res, 403, { error: "forbidden" });
    return true;
  };
  return [
    {
      method: "GET",
      path: "/api/ui-canvas/:sessionId",
      handle: async (c: UiCanvasCtx) => {
        if (guard(c)) return;
        return d.relayCore(c.res, "GET", canvasPath(c.params.sessionId!, c.user));
      },
    },
    {
      method: "GET",
      path: "/api/ui-canvas/:sessionId/script.js",
      handle: async (c: UiCanvasCtx) => {
        if (guard(c)) return;
        const { res, params, url, user } = c;
        const sessionId = params.sessionId!;
        const r = await d.coreFetch("GET", canvasPath(sessionId, user));
        if (r.status !== 200) return d.relay(res, r);
        let canvas: { js?: unknown; rev?: unknown } | undefined;
        try {
          canvas = (JSON.parse(r.text) as { canvas?: { js?: unknown; rev?: unknown } }).canvas;
        } catch {
          return d.json(res, 502, { error: "bad_core_response" });
        }
        if (typeof canvas?.js !== "string") return d.json(res, 404, { error: "not_found" });
        if (String(canvas.rev) !== url.searchParams.get("rev")) return d.json(res, 409, { error: "stale_revision" });
        res.writeHead(200, {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(
          `((canvas) => {\n${canvas.js}\n})(window.qmUiCanvasTake?.(${JSON.stringify(sessionId)}, ${Number(canvas.rev)}));\n`,
        );
      },
    },
    {
      method: "POST",
      path: "/api/ui-canvas/observe/:callId",
      handle: async (c: UiCanvasCtx) => {
        if (guard(c)) return;
        const body = await d.readJson<{ snapshot?: unknown }>(c.req, c.res, false);
        if (!body) return;
        const path = `/v1/ui/observe/${encodeURIComponent(c.params.callId!)}/result`;
        return d.relayCore(c.res, "POST", path, JSON.stringify({ snapshot: body.snapshot, principalId: c.user }));
      },
    },
    {
      method: "POST",
      path: "/api/ui-canvas/:sessionId",
      handle: async (c: UiCanvasCtx) => {
        if (guard(c)) return;
        const body = await d.readJson<{ pinned?: unknown; dismiss?: unknown }>(c.req, c.res, false);
        if (!body) return;
        const path = `/v1/ui/canvases/${encodeURIComponent(c.params.sessionId!)}`;
        const payload = { pinned: body.pinned, dismiss: body.dismiss, principalId: c.user };
        return d.relayCore(c.res, "POST", path, JSON.stringify(payload));
      },
    },
  ];
}
