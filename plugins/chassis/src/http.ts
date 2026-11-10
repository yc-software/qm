import { type IncomingMessage, type OutgoingMessage, type Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Readable, type Writable } from "node:stream";
import { gzip } from "node:zlib";

const COMPRESS_MIN_BYTES = 1024;

const ALB_IDLE_TIMEOUT_MS = 60_000;
export const KEEP_ALIVE_TIMEOUT_MS = ALB_IDLE_TIMEOUT_MS + 5_000;

type ConnectionState = {
  openedAt: number;
  lastAnsweredAt: number;
  answeredBytes: number;
  served: number;
  error?: string;
  draining: boolean;
  pending?: { method: string; path: string; trace: string; startedAt: number };
};

export function logUnansweredCloses(server: Server, label: string): void {
  const states = new WeakMap<Socket, ConnectionState>();
  server.on("connection", (socket: Socket) => {
    const now = Date.now();
    const state: ConnectionState = { openedAt: now, lastAnsweredAt: now, answeredBytes: 0, served: 0, draining: false };
    states.set(socket, state);
    socket.on("error", (error: NodeJS.ErrnoException) => (state.error = `${error.code ?? "unknown"} ${error.message}`));
    socket.on("close", () => {
      if (states.get(socket) !== state) return;
      const unreadBytes = socket.bytesRead - state.answeredBytes;
      if (!state.pending && (unreadBytes <= 0 || state.draining)) return;
      const closedAt = Date.now();
      const request = state.pending
        ? `${state.pending.method} ${state.pending.path} after ${closedAt - state.pending.startedAt}ms trace=${state.pending.trace}`
        : "none parsed";
      console.warn(
        "[http] %s connection closed before answering: request=%s unanswered_bytes=%d idle_before=%dms connection_age=%dms served=%d error=%s",
        label,
        request,
        unreadBytes,
        (state.pending?.startedAt ?? closedAt) - state.lastAnsweredAt,
        closedAt - state.openedAt,
        state.served,
        state.error ?? "none",
      );
    });
  });
  server.on("upgrade", (req: IncomingMessage) => states.delete(req.socket));
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const state = states.get(req.socket);
    if (!state) return;
    const url = req.url ?? "?";
    const query = url.indexOf("?");
    const trace = req.headers["x-amzn-trace-id"];
    state.pending = {
      method: req.method ?? "?",
      path: query < 0 ? url : url.slice(0, query),
      trace: typeof trace === "string" ? trace : "none",
      startedAt: Date.now(),
    };
    res.once("finish", () => {
      state.pending = undefined;
      state.lastAnsweredAt = Date.now();
      state.served += 1;
      if (req.complete) return void (state.answeredBytes = req.socket.bytesRead);
      state.draining = true;
      req.once("end", () => {
        state.draining = false;
        state.answeredBytes = req.socket.bytesRead;
      });
    });
  });
}

export function isLoopbackUrl(raw: string): boolean {
  const hostname = URL.parse(raw)?.hostname.toLowerCase();
  return (
    hostname === "localhost" || !!hostname?.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

export const isSecureOrLoopbackUrl = (raw: string): boolean =>
  raw.startsWith("https://") || (raw.startsWith("http://") && isLoopbackUrl(raw));

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

export function withVary(res: ServerResponse, value: string): string {
  const existing = res.getHeader("vary");
  const tokens = [...(existing === undefined ? [] : String(existing).split(",")), ...value.split(",")]
    .map((token) => token.trim())
    .filter(Boolean);
  return [...new Map(tokens.map((token) => [token.toLowerCase(), token])).values()].join(", ");
}

export function sendBuffered(res: ServerResponse, status: number, headers: Record<string, string>, body: string): void {
  const out = { ...headers, vary: withVary(res, "accept-encoding") };
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

export function relayStream(
  source: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
  dest: OutgoingMessage | Writable,
  options: { end?: boolean; onError?: (error: Error) => void } = {},
): void {
  const from =
    source instanceof ReadableStream
      ? Readable.fromWeb(source as Parameters<typeof Readable.fromWeb>[0])
      : (source as Readable);
  const release = (): void => {
    if (dest instanceof ServerResponse) from.destroy();
    else from.unpipe(dest);
  };
  from.on("error", (error: Error) => {
    options.onError?.(error);
    dest.destroy();
  });
  dest.on("error", release);
  dest.on("close", () => {
    if (!dest.writableFinished) release();
  });
  if (dest.destroyed) return release();
  from.pipe(dest, { end: options.end ?? true });
}

export async function readBodyBytes(req: IncomingMessage, maxBytes = Infinity): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw new PayloadTooLargeError();
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readBody(req: IncomingMessage, maxBytes = Infinity): Promise<string> {
  return (await readBodyBytes(req, maxBytes)).toString("utf8");
}

export function originOf(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

export function sameOriginRequest(req: IncomingMessage, expectedOrigin: string): boolean {
  const origin = req.headers.origin;
  const originMatches =
    typeof origin === "string" &&
    (() => {
      try {
        return new URL(origin).origin === expectedOrigin;
      } catch {
        return false;
      }
    })();
  const site = req.headers["sec-fetch-site"];
  if (typeof site !== "string") return originMatches;
  return site === "same-origin" && (originMatches || origin === undefined || origin === "null");
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

const SVG_DOCUMENT = /^<svg[\s>][\s\S]*<\/svg>$/i;

function faviconSvg(icon: { svg?: string; emoji: string }): string {
  const custom = icon.svg?.trim() ?? "";
  if (SVG_DOCUMENT.test(custom)) return custom;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90" text-anchor="middle" x="50">${icon.emoji}</text></svg>`;
}

export function serveFavicon(res: ServerResponse, icon: { svg?: string; emoji: string }, cacheControl: string): void {
  res.writeHead(200, {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(faviconSvg(icon));
}
