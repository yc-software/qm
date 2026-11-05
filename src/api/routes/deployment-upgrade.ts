import {
  request as httpRequest,
  type Agent,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { Duplex } from "node:stream";
import { sendJson } from "../http.ts";

export interface UpgradeTarget {
  socket: Duplex;
  head: Buffer;
}

export interface UpgradeEndpoint {
  host: string;
  port: number;
  tls?: boolean;
}

const UPGRADE_DIAL_TIMEOUT_MS = 20_000;
const PASSED_RESPONSE_HEADERS = ["sec-websocket-accept", "sec-websocket-protocol", "sec-websocket-extensions"];

export function isWebSocketUpgrade(req: IncomingMessage): boolean {
  return req.method === "GET" && String(req.headers.upgrade ?? "").toLowerCase() === "websocket";
}

export function upgradeOriginAllowed(req: IncomingMessage, rawHost: string): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).hostname.toLowerCase() === rawHost;
  } catch {
    return false;
  }
}

function switchingProtocols(headers: Record<string, string | string[] | undefined>): string {
  const lines = ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade"];
  for (const name of PASSED_RESPONSE_HEADERS) {
    const value = headers[name];
    if (typeof value === "string") lines.push(`${name}: ${value}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function splice(client: Duplex, upstream: Duplex): void {
  const close = (): void => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close);
  upstream.on("error", close);
  for (const side of [client, upstream]) {
    side.on("close", close);
    side.on("end", close);
  }
  upstream.pipe(client);
  client.pipe(upstream);
}

function refuse(res: ServerResponse, status: number, error: string, message: string): void {
  if (res.headersSent || res.destroyed) return void res.destroy();
  sendJson(res, status, { error, message });
}

function relayRejection(
  res: ServerResponse,
  status: number,
  headers: IncomingHttpHeaders,
  body: NodeJS.ReadableStream,
): void {
  if (res.headersSent || res.destroyed) return void res.destroy();
  const type = headers["content-type"];
  res.writeHead(status, { ...(typeof type === "string" ? { "content-type": type } : {}), "cache-control": "no-store" });
  body.pipe(res);
}

export function proxyWebSocketUpgrade(
  res: ServerResponse,
  target: UpgradeTarget,
  endpoint: UpgradeEndpoint,
  path: string,
  headers: Record<string, string | string[]>,
  agent?: Agent,
): void {
  const requestFn = endpoint.tls ? httpsRequest : httpRequest;
  const options: RequestOptions = {
    hostname: endpoint.host,
    port: endpoint.port,
    path,
    method: "GET",
    headers: { ...headers, connection: "Upgrade", upgrade: "websocket" },
    ...(agent ? { agent } : {}),
  };
  const up = requestFn(options);
  up.setTimeout(UPGRADE_DIAL_TIMEOUT_MS, () => {
    up.destroy();
    refuse(res, 504, "gateway_timeout", "deployment did not respond");
  });
  up.on("upgrade", (upRes, upSocket, upHead) => {
    up.setTimeout(0);
    if (target.socket.destroyed) return void upSocket.destroy();
    target.socket.write(switchingProtocols(upRes.headers));
    if (upHead.length) target.socket.write(upHead);
    if (target.head.length) upSocket.write(target.head);
    splice(target.socket, upSocket);
  });
  up.on("response", (upRes) => {
    up.setTimeout(0);
    relayRejection(res, upRes.statusCode ?? 502, upRes.headers, upRes);
  });
  up.on("error", () => refuse(res, 502, "bad_gateway", "deployment unreachable"));
  target.socket.on("close", () => up.destroy());
  up.end();
}
