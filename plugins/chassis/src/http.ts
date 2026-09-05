import type { IncomingMessage, ServerResponse } from "node:http";

export class PayloadTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "PayloadTooLargeError";
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function readBytes(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req.iterator({ destroyOnReturn: false })) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw new PayloadTooLargeError();
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readBody(req: IncomingMessage, maxBytes = Infinity): Promise<string> {
  return (await readBytes(req, maxBytes)).toString("utf8");
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
