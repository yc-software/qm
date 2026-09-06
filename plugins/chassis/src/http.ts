import type { IncomingMessage, ServerResponse } from "node:http";
import { gzip } from "node:zlib";

const COMPRESS_MIN_BYTES = 1024;

export class PayloadTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "PayloadTooLargeError";
  }
}

export function gzipAccepted(req: IncomingMessage | undefined): boolean {
  const header = req?.headers["accept-encoding"];
  if (header === undefined) return false;
  let explicit: boolean | undefined;
  let wildcard: boolean | undefined;
  for (const part of (Array.isArray(header) ? header.join(",") : header).split(",")) {
    const [name, ...params] = part.split(";");
    const token = (name ?? "").trim().toLowerCase();
    if (token !== "gzip" && token !== "*") continue;
    const q = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith("q="));
    const weight = q === undefined ? 1 : Number.parseFloat(q.slice(2));
    const allowed = Number.isFinite(weight) && weight > 0;
    if (token === "*") wildcard = allowed;
    else explicit = allowed;
  }
  return explicit ?? wildcard ?? false;
}

export function sendBuffered(res: ServerResponse, status: number, headers: Record<string, string>, body: string): void {
  const out = { ...headers, vary: "accept-encoding" };
  if (Buffer.byteLength(body) < COMPRESS_MIN_BYTES || !gzipAccepted(res.req)) {
    res.writeHead(status, out);
    res.end(body);
    return;
  }
  gzip(body, (err, packed) => {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    try {
      if (err) {
        res.writeHead(status, out);
        res.end(body);
        return;
      }
      res.writeHead(status, { ...out, "content-encoding": "gzip", "content-length": String(packed.length) });
      res.end(packed);
    } catch {
      res.destroy();
    }
  });
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  sendBuffered(res, status, { "content-type": "application/json" }, JSON.stringify(body));
}

export async function readBody(req: IncomingMessage, maxBytes = Infinity): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw new PayloadTooLargeError();
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function cookie(req: IncomingMessage, name: string): string | null {
  const m = (req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1] ?? "") || null : null;
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

export function serveEmojiFavicon(res: ServerResponse, emoji: string, cacheControl: string): void {
  res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": cacheControl });
  res.end(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90" text-anchor="middle" x="50">${emoji}</text></svg>`,
  );
}
