import type { IncomingMessage } from "node:http";

type Field = { in: "query" | "body" | "header"; name: string };
type Rule = { method: string; re: RegExp; field?: Field };

function pat(method: string, template: string, field?: Field): Rule {
  const re = new RegExp("^" + template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[^/]+/g, "[^/]+") + "$");
  return field ? { method, re, field } : { method, re };
}

const USER_SCOPED: Rule[] = [
  pat("GET", "/v1/sessions/search", { in: "query", name: "principalId" }),
  pat("GET", "/v1/sessions/:id", { in: "query", name: "viewer" }),
  pat("GET", "/v1/sessions/:id/entries/:seq", { in: "query", name: "viewer" }),
  pat("GET", "/v1/sessions/:id/approvals", { in: "query", name: "viewer" }),
  pat("GET", "/v1/sessions/:id/background", { in: "query", name: "viewer" }),
  pat("GET", "/v1/sessions/:id/background/:pid/output", { in: "query", name: "viewer" }),
  pat("GET", "/v1/files/:id/content", { in: "query", name: "viewer" }),
  pat("GET", "/v1/files", { in: "query", name: "viewer" }),
  pat("POST", "/v1/files/upload", { in: "body", name: "principalId" }),
  pat("POST", "/v1/sessions/:id", { in: "body", name: "principalId" }),
  pat("POST", "/v1/sessions/:id/title", { in: "body", name: "principalId" }),
  pat("POST", "/v1/sessions/:id/fork", { in: "body", name: "principalId" }),
  pat("GET", "/v1/sessions", { in: "query", name: "principalId" }),
  pat("GET", "/v1/contexts", { in: "query", name: "principalId" }),
  pat("GET", "/v1/projects", { in: "query", name: "principalId" }),
  pat("POST", "/v1/projects", { in: "body", name: "principalId" }),
  pat("POST", "/v1/projects/:id/members", { in: "body", name: "principalId" }),
  pat("DELETE", "/v1/projects/:id/members/:memberId", { in: "body", name: "principalId" }),
  pat("GET", "/v1/scope-resources", { in: "query", name: "principalId" }),
  pat("GET", "/v1/memory", { in: "query", name: "principalId" }),
  pat("PUT", "/v1/memory", { in: "body", name: "principalId" }),
  pat("GET", "/v1/memory/history", { in: "query", name: "principalId" }),
  pat("POST", "/v1/memory/restore", { in: "body", name: "principalId" }),
  pat("GET", "/v1/contexts/policy", { in: "query", name: "principalId" }),
  pat("GET", "/v1/skills", { in: "query", name: "principalId" }),
  pat("GET", "/v1/skills/:id", { in: "query", name: "principalId" }),
  pat("POST", "/v1/skills", { in: "body", name: "principalId" }),
  pat("PUT", "/v1/skills/:id", { in: "body", name: "principalId" }),
  pat("DELETE", "/v1/skills/:id", { in: "body", name: "principalId" }),
  pat("POST", "/v1/skills/:id/restore", { in: "body", name: "principalId" }),
  pat("POST", "/v1/soul", { in: "body", name: "actorId" }),
  pat("POST", "/v1/webhooks", { in: "body", name: "createdBy" }),
  pat("GET", "/v1/webhooks", { in: "query", name: "viewer" }),
  pat("GET", "/v1/crons", { in: "query", name: "viewer" }),
  pat("POST", "/v1/crons", { in: "body", name: "createdBy" }),
  pat("GET", "/v1/crons/:id", { in: "query", name: "principalId" }),
  pat("PATCH", "/v1/crons/:id", { in: "query", name: "principalId" }),
  pat("DELETE", "/v1/crons/:id", { in: "query", name: "principalId" }),
  pat("POST", "/v1/crons/:id/disable", { in: "query", name: "principalId" }),
  pat("POST", "/v1/crons/:id/run", { in: "query", name: "principalId" }),
  pat("POST", "/v1/crons/:id/destination", { in: "query", name: "principalId" }),
  pat("GET", "/v1/crons/:id/runs", { in: "query", name: "principalId" }),
  pat("GET", "/v1/deployments", { in: "query", name: "principalId" }),
  pat("POST", "/v1/deployments", { in: "body", name: "createdBy" }),
  pat("GET", "/v1/connectors/oauth/:provider/start", { in: "query", name: "principalId" }),
  pat("GET", "/v1/connectors/oauth/status", { in: "query", name: "principalId" }),
  pat("POST", "/v1/connectors/token", { in: "body", name: "principalId" }),
  pat("POST", "/v1/connectors/oauth/revoke", { in: "body", name: "principalId" }),
  pat("POST", "/v1/webhooks/:id/disable", { in: "query", name: "principalId" }),
  pat("POST", "/v1/deployments/:id/display-name"),
  pat("POST", "/v1/deployments/:id/name"),
  pat("POST", "/v1/deployments/:id/archive"),
  pat("POST", "/v1/deployments/:id/restore"),
  pat("POST", "/v1/deployments/:id/rollback"),
  pat("POST", "/v1/deployments/:id/redeploy"),
  pat("POST", "/v1/deployments/:id/share"),
  pat("GET", "/v1/approvals/:id"),
  pat("GET", "/v1/approvals/pending"),
  pat("GET", "/v1/directory/resolve"),
  pat("POST", "/v1/reach"),
  pat("POST", "/v1/share"),
  pat("POST", "/v1/environments"),
  pat("POST", "/v1/environments/attach"),
  pat("POST", "/v1/emoji"),
  pat("GET", "/v1/runs/:id"),
  pat("GET", "/v1/runs"),
  pat("POST", "/v1/runs/:id/signal"),
];

const SYSTEM: Rule[] = [
  pat("POST", "/v1/turns"),
  pat("POST", "/v1/turns/:id/metrics"),
  pat("POST", "/v1/runs/:id/delivery-state"),
  pat("POST", "/v1/deliveries/:id/ack"),
  pat("POST", "/v1/deliveries/ack-by-key"),
  pat("POST", "/v1/directory"),
  pat("POST", "/v1/principals/:id/deactivate"),
  pat("POST", "/v1/principals/:id/reactivate"),
  pat("POST", "/v1/surface-cache/ingest"),
  pat("POST", "/v1/surface-cache/policy"),
  pat("POST", "/v1/surface-context/:id/result"),
  pat("POST", "/v1/grants"),
  pat("POST", "/v1/grants/revoke"),
  pat("POST", "/v1/blobs"),
  pat("POST", "/v1/egress-audit"),
  pat("POST", "/v1/auth/broker/claim"),
  pat("PUT", "/v1/deployment-layer"),
  pat("POST", "/v1/session-cap"),
  pat("POST", "/v1/keychain/drops/:id"),
  pat("POST", "/v1/keychain/asks"),
  pat("POST", "/v1/keychain/asks/:id/decline"),
  pat("POST", "/v1/keychain/credentials"),
  pat("DELETE", "/v1/keychain/credentials/:id"),
  pat("POST", "/v1/keychain/drops"),
  pat("POST", "/v1/keychain/grants"),
  pat("POST", "/v1/keychain/grants/:id/revoke"),
  pat("POST", "/v1/keychain/use"),
  pat("POST", "/v1/surface-context"),
  pat("POST", "/v1/surface-file"),
  pat("POST", "/v1/triggers/:id/consent"),
];

const WRITE = new Set(["POST", "PUT", "DELETE", "PATCH"]);

export function isUserScoped(method: string, pathname: string): boolean {
  return USER_SCOPED.some((r) => r.method === method && r.re.test(pathname));
}

export function userScopedField(method: string, pathname: string): Field | undefined {
  return USER_SCOPED.find((r) => r.method === method && !!r.field && r.re.test(pathname))?.field;
}

export function isUnclassifiedWrite(method: string, pathname: string): boolean {
  if (!WRITE.has(method)) return false;
  if (pathname.startsWith("/v1/admin/")) return false;
  if (userScopedField(method, pathname)) return false;
  return !SYSTEM.some((r) => r.method === method && r.re.test(pathname));
}

export function assertedActor(field: Field, url: URL, body: unknown, req: IncomingMessage): string | null {
  if (field.in === "query") return url.searchParams.get(field.name);
  if (field.in === "header") {
    const v = req.headers[field.name];
    return (Array.isArray(v) ? v[0] : v) ?? null;
  }
  const b = body as Record<string, unknown> | null;
  const v = b && typeof b === "object" ? b[field.name] : undefined;
  return typeof v === "string" ? v : null;
}
