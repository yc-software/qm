import type { IncomingMessage, ServerResponse } from "node:http";

export function answerFeatures(req: IncomingMessage, res: ServerResponse, grants: Record<string, string[]>): boolean {
  const url = new URL(req.url ?? "/", "http://core");
  if (url.pathname !== "/v1/features") return false;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ enabled: grants[url.searchParams.get("principalId") ?? ""] ?? [] }));
  return true;
}
