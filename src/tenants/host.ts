import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { requestHost } from "../../plugins/chassis/src/tenant-hosts.ts";
import { tenant, withTenant, type Tenant } from "../tenant.ts";
import { reportFailure } from "../util/errors.ts";
import { tenantByHost } from "./directory.ts";

const HEALTH_PATHS: ReadonlySet<string> = new Set(["/healthz", "/readyz"]);
const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function pathOf(req: IncomingMessage): string {
  const url = req.url ?? "/";
  const q = url.indexOf("?");
  return q < 0 ? url : url.slice(0, q);
}

export function createTenantFront(server: Server): Server {
  const home = tenant();
  const resolve = async (req: IncomingMessage): Promise<Tenant | "unknown" | "unavailable"> => {
    if (HEALTH_PATHS.has(pathOf(req))) return home;
    const host = LOOPBACK.has(req.socket.remoteAddress ?? "") ? requestHost(req.headers) : req.headers.host;
    try {
      return (await tenantByHost(host)) ?? "unknown";
    } catch (error) {
      reportFailure("tenant front: tenant lookup failed", error);
      return "unavailable";
    }
  };
  const front = createServer((req: IncomingMessage, res: ServerResponse) => {
    void resolve(req).then((found) => {
      if (typeof found === "object") return withTenant(found, () => void server.emit("request", req, res));
      if (found === "unknown")
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("unknown host\n");
      else res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("tenant unavailable\n");
    });
  });
  front.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void resolve(req).then((found) => {
      if (typeof found === "object") return withTenant(found, () => void server.emit("upgrade", req, socket, head));
      socket.end(
        `HTTP/1.1 ${found === "unknown" ? "404 Not Found" : "503 Service Unavailable"}\r\nconnection: close\r\n\r\n`,
      );
    });
  });
  front.requestTimeout = 0;
  front.headersTimeout = 10_000;
  front.keepAliveTimeout = 5_000;
  return front;
}
