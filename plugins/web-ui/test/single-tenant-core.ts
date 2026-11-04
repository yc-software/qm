import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export function answeredHostLookup(req: IncomingMessage, res: ServerResponse): boolean {
  if (!(req.url ?? "").startsWith("/v1/operator/hosts/")) return false;
  req.resume();
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_configured", message: "tenancy needs Postgres" }));
  return true;
}

export async function singleTenantCore(): Promise<string> {
  const core = createServer((req, res) => {
    if (answeredHostLookup(req, res)) return;
    req.resume();
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
  core.unref();
  return `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
}
