import { createHmac } from "node:crypto";

function token(secret: string, domain: string, parts: readonly unknown[]): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify([domain, ...parts]))
    .digest("hex");
}

export function memoryScopeToken(secret: string, scopeId: string): string {
  return createHmac("sha256", secret).update(scopeId).digest("hex");
}

export function memoryOperationToken(secret: string, integrationId: string, operationId: string): string {
  return token(secret, "memory-operation-v1", [integrationId, operationId]);
}

export function memoryAuditToken(
  secret: string,
  integrationId: string,
  operationId: string,
  action: string,
  request: readonly unknown[],
): string {
  return token(secret, "memory-audit-v1", [integrationId, operationId, action, request]);
}

export function memoryTombstoneKeyCheck(secret: string): string {
  return token(secret, "memory-tombstone-key-check-v1", []);
}
