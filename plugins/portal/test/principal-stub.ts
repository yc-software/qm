import type { IncomingMessage, ServerResponse } from "node:http";

/** Core's `GET /v1/identities/:provider/:id/principal`, stubbed: every subject is its own principal. */
export function answerPrincipalLookup(req: IncomingMessage, res: ServerResponse): boolean {
  const m = req.url?.match(/^\/v1\/identities\/[a-z]+\/([^/?]+)\/principal/);
  if (!m) return false;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ principalId: decodeURIComponent(m[1]!) }));
  return true;
}
