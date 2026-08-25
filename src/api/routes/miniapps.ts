import type { BaseCtx, Route } from "./route.ts";
import {
  MINIAPP_CSP,
  openMiniapp,
  parseMiniappTheme,
  parseMiniappView,
  skinMiniappHtml,
} from "../../miniapps/miniapp.ts";

const NOT_FOUND = `<!doctype html><meta charset="utf-8"><title>Not found</title><body style="font-family:system-ui;margin:4rem auto;max-width:32rem;padding:0 1rem"><h1>Playground not found</h1><p>This miniapp is gone or the link is wrong.</p></body>`;

async function serveMiniapp(ctx: BaseCtx): Promise<void> {
  const { res, deps, params } = ctx;
  if (!deps.miniapps) {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(NOT_FOUND);
    return;
  }
  const rec = await openMiniapp(deps.miniapps, params.id ?? "", params.key ?? "");
  if (!rec) {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(NOT_FOUND);
    return;
  }
  const theme = parseMiniappTheme(ctx.url.searchParams.get("theme"));
  if (parseMiniappView(ctx.url.searchParams.get("view"))) {
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(Buffer.byteLength(rec.html, "utf8")),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "private, no-cache",
    });
    res.end(rec.html);
    return;
  }
  const body = skinMiniappHtml(rec.html, theme);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(Buffer.byteLength(body, "utf8")),
    "content-security-policy": MINIAPP_CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-cache",
  });
  res.end(body);
}

export const miniappRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "GET", path: "/m/:id/:key", auth: "public", handle: serveMiniapp },
];
