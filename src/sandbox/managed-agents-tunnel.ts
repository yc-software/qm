import { createServer, type Server, type Socket } from "node:net";
import { once } from "node:events";
import type WebSocket from "ws";

export const SANDBOX_AGENT_PORT = 8443;

const TUNNEL_CLOSE_SESSION_UNAVAILABLE = 4001;
const TUNNEL_CLOSE_GUEST_DIAL_FAILED = 4002;
const TUNNEL_CLOSE_UPSTREAM_ERROR = 4011;
const REJECTION_BODY_MAX = 300;
const PING_INTERVAL_MS = 30_000;

export interface ManagedAgentsTunnel {
  readonly localPort: number;
  lastFailure(): string | null;
  whenFailed(): Promise<string>;
  close(): Promise<void>;
}

export interface ManagedAgentsTunnelOptions {
  apiBaseUrl: string;
  sessionId: string;
  remotePort: number;
  getToken: () => Promise<string>;
  pingIntervalMs?: number;
}

export function tunnelUrl(apiBaseUrl: string, sessionId: string, remotePort: number): string {
  const url = new URL(apiBaseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`DO_AGENTS_API_BASE_URL must be http(s), got ${url.protocol}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v2/agents/sessions/${sessionId}/port-forward/${remotePort}`;
  return url.toString();
}

type WebSocketCtor = typeof WebSocket;

let wsModule: WebSocketCtor | null = null;
async function loadWebSocket(): Promise<WebSocketCtor> {
  wsModule ??= (await import("ws")).default;
  return wsModule;
}

export async function openManagedAgentsTunnel(opts: ManagedAgentsTunnelOptions): Promise<ManagedAgentsTunnel> {
  const WebSocketImpl = await loadWebSocket();
  const url = tunnelUrl(opts.apiBaseUrl, opts.sessionId, opts.remotePort);
  const sockets = new Set<Socket>();
  let failure: string | null = null;
  let closed = false;
  let announceFailure: (detail: string) => void = () => undefined;
  const failed = new Promise<string>((resolve) => {
    announceFailure = resolve;
  });
  const fail = (detail: string): void => {
    failure = detail;
    announceFailure(detail);
  };

  const bridge = (local: Socket): void => {
    sockets.add(local);
    local.once("close", () => sockets.delete(local));
    void opts
      .getToken()
      .then((token) => {
        if (closed) {
          local.destroy();
          return;
        }
        const ws = new WebSocketImpl(url, { headers: { Authorization: `Bearer ${token}` } });
        let rejected = false;

        ws.on("unexpected-response", (_req, res) => {
          rejected = true;
          let body = "";
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString("utf8");
          });
          res.on("end", () => {
            fail(`${res.statusCode ?? 0} ${body.trim().slice(0, REJECTION_BODY_MAX)}`.trim());
            local.destroy();
          });
        });

        ws.on("open", () => {
          const heartbeat = setInterval(() => {
            if (ws.readyState === WebSocketImpl.OPEN) ws.ping();
          }, opts.pingIntervalMs ?? PING_INTERVAL_MS);
          heartbeat.unref();
          ws.once("close", () => clearInterval(heartbeat));
          local.on("data", (chunk: Buffer) => {
            local.pause();
            ws.send(chunk, (err) => {
              if (err) return;
              local.resume();
            });
          });
          ws.on("message", (data: Buffer) => {
            if (!local.write(data)) {
              ws.pause();
              local.once("drain", () => ws.resume());
            }
          });
        });

        ws.on("close", (code: number, reason: Buffer) => {
          if (
            code === TUNNEL_CLOSE_SESSION_UNAVAILABLE ||
            code === TUNNEL_CLOSE_GUEST_DIAL_FAILED ||
            code === TUNNEL_CLOSE_UPSTREAM_ERROR
          )
            fail(`close ${code} ${reason.toString("utf8")}`.trim());
          local.destroy();
        });

        ws.on("error", (err: Error) => {
          if (!rejected) fail(err.message);
          local.destroy();
        });

        local.on("close", () => {
          if (ws.readyState === WebSocketImpl.OPEN || ws.readyState === WebSocketImpl.CONNECTING) ws.close();
        });
        local.on("error", () => ws.close());
      })
      .catch((err: unknown) => {
        fail(err instanceof Error ? err.message : String(err));
        local.destroy();
      });
  };

  const server: Server = createServer(bridge);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  server.unref();
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Managed Agents tunnel failed to bind a local port");

  return {
    localPort: address.port,
    lastFailure: () => failure,
    whenFailed: () => failed,
    close: async () => {
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
