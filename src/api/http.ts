import type { IncomingMessage, ServerResponse } from "node:http";
import { gzip } from "node:zlib";
import { verifySignature, type SourceAuth, SOURCE_AUTH_REPLAY_WINDOW_MS } from "../auth/source-auth.ts";

const COMPRESS_MIN_BYTES = 1024;

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

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  sendBuffered(res, status, { "content-type": "application/json" }, JSON.stringify(body));
}

const BODY_DEADLINE = Symbol.for("qm.bodyDeadline");
type DeadlineCarrier = IncomingMessage & { [BODY_DEADLINE]?: { rearm: (ms: number) => void } };

export function armBodyDeadline(req: IncomingMessage, ms: number): void {
  let timer: NodeJS.Timeout | undefined;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const arm = (deadlineMs: number) => {
    clear();
    timer = setTimeout(() => {
      if (req.complete || req.readableEnded) return;
      req.destroy(new Error(`request body not received within ${deadlineMs}ms`));
    }, deadlineMs);
    timer.unref();
  };
  req.once("end", clear);
  req.once("close", clear);
  (req as DeadlineCarrier)[BODY_DEADLINE] = { rearm: arm };
  arm(ms);
}

export function extendBodyDeadline(req: IncomingMessage, ms: number): void {
  (req as DeadlineCarrier)[BODY_DEADLINE]?.rearm(ms);
}

export function contentTypeWithUtf8Charset(contentType: string): string {
  let parameterStart = -1;
  let inQuotes = false;
  let escaped = false;
  for (let i = 0; i < contentType.length; i += 1) {
    const character = contentType[i]!;
    if (escaped) {
      escaped = false;
    } else if (inQuotes && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && character === ";") {
      if (parameterStart >= 0 && /^\s*charset\s*=/i.test(contentType.slice(parameterStart, i))) return contentType;
      parameterStart = i + 1;
    }
  }
  if (parameterStart >= 0 && /^\s*charset\s*=/i.test(contentType.slice(parameterStart))) return contentType;
  const mime = contentType.split(";", 1)[0]!.trim().toLowerCase();
  const textual =
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/yaml" ||
    mime === "application/x-yaml" ||
    mime === "application/javascript" ||
    mime === "application/x-javascript" ||
    mime === "application/graphql" ||
    mime === "application/sql" ||
    mime === "application/toml" ||
    mime === "image/svg+xml" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml") ||
    mime.endsWith("+yaml");
  return textual ? `${contentType}; charset=utf-8` : contentType;
}

export function pipeToResponse(
  res: ServerResponse,
  stream: NodeJS.ReadableStream & { destroy?: () => void },
  errorMessage: string,
): void {
  stream.on("error", () => {
    if (!res.headersSent) sendJson(res, 500, { error: "stream_error", message: errorMessage });
    else res.destroy();
  });
  res.on("close", () => stream.destroy?.());
  stream.pipe(res);
}

export function sendRedirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
}

export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
}

export class PayloadTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "PayloadTooLargeError";
  }
}

const MAX_BODY_BYTES = 1_000_000;

export async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError();
    chunks.push(chunk as Buffer);
  }
  return chunks.length === 0 ? "" : Buffer.concat(chunks).toString("utf8");
}

export function canonicalPayload(method: string, pathWithQuery: string, tail: string): string {
  return `${method}\n${pathWithQuery}\n${tail}`;
}

export async function verifyOrReject(
  req: IncomingMessage,
  res: ServerResponse,
  secret: string | undefined,
  auth: SourceAuth | null,
  payload: string,
  dedup: boolean,
  allowUnsigned = false,
): Promise<boolean> {
  if (!secret) {
    if (allowUnsigned) return true;
    sendJson(res, 401, { error: "unauthorized", message: "source authentication is not configured" });
    return false;
  }
  const signature = String(req.headers["x-signature"] ?? "");
  const timestamp = Number(req.headers["x-timestamp"] ?? NaN);
  const r =
    dedup && auth
      ? await auth.verify({ signature, timestamp, body: payload, eventId: signature })
      : verifySignature(secret, { signature, timestamp, body: payload }, Date.now(), SOURCE_AUTH_REPLAY_WINDOW_MS);
  if (!r.ok) {
    sendJson(res, 401, { error: "unauthorized", message: r.reason });
    return false;
  }
  return true;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function contentDispositionAttachment(name: string, kind: "attachment" | "inline" = "attachment"): string {
  const fallback = name.replace(/[\r\n"\\]/g, "_").replace(/[^\x20-\x7e]/g, "_") || "download";
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
