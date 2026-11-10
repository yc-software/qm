import { request as httpRequest, ServerResponse, type Agent, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { reportBackendError } from "./error-reporting.ts";
import { json, relayStream } from "./http.ts";

export interface UpgradeTarget {
  socket: Duplex;
  head: Buffer;
}

export interface RelayTarget {
  tls: boolean;
  hostname: string;
  port?: number | string;
  path: string;
  headers: Record<string, string | string[]>;
  timeoutMs?: number;
  agent?: Agent;
}

const PASSED_RESPONSE_HEADERS = ["sec-websocket-accept", "sec-websocket-protocol", "sec-websocket-extensions"];

export function isWebSocketUpgrade(req: IncomingMessage): boolean {
  return req.method === "GET" && String(req.headers.upgrade ?? "").toLowerCase() === "websocket";
}

export function responseOnSocket(req: IncomingMessage, socket: Duplex): ServerResponse | null {
  if (!(socket instanceof Socket)) return null;
  const res = new ServerResponse(req);
  res.assignSocket(socket);
  res.shouldKeepAlive = false;
  res.on("finish", () => socket.end());
  return res;
}

export function failUpgrade(socket: Duplex, label: string, error: unknown): void {
  reportBackendError(error, label);
  console.error("[%s] %s", label, error instanceof Error ? error.message : String(error));
  socket.destroy();
}

function switchingProtocols(headers: IncomingMessage["headers"]): string {
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
  for (const side of [client, upstream]) {
    side.on("error", close);
    side.on("end", close);
    side.on("close", close);
  }
  relayStream(upstream, client);
  relayStream(client, upstream);
}

function refuse(res: ServerResponse, status: number, error: string, message: string): void {
  if (res.headersSent || res.destroyed) return void res.destroy();
  json(res, status, { error, message });
}

export function relayWebSocket(res: ServerResponse, target: UpgradeTarget, to: RelayTarget, label: string): void {
  const up = (to.tls ? httpsRequest : httpRequest)({
    hostname: to.hostname,
    port: to.port,
    path: to.path,
    method: "GET",
    headers: { ...to.headers, connection: "Upgrade", upgrade: "websocket" },
    ...(to.agent ? { agent: to.agent } : {}),
  });
  if (to.timeoutMs !== undefined)
    up.setTimeout(to.timeoutMs, () => {
      up.destroy();
      refuse(res, 504, "gateway_timeout", "upstream did not respond");
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
    if (res.headersSent || res.destroyed) return void res.destroy();
    const type = upRes.headers["content-type"];
    res.writeHead(upRes.statusCode ?? 502, {
      ...(typeof type === "string" ? { "content-type": type } : {}),
      "cache-control": "no-store",
    });
    relayStream(upRes, res);
  });
  up.on("error", (error) => {
    console.error("[%s] upgrade dial failed: %s", label, error.message);
    refuse(res, 502, "bad_gateway", "upstream unreachable");
  });
  target.socket.on("close", () => up.destroy());
  up.end();
}
