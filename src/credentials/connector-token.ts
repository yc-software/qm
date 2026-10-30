import { hashId } from "../util/crypto.ts";

export function envKey(host: string, principalId?: string): string {
  const normalizedHost = host.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  if (!principalId) return `VAULT_TOKEN_${normalizedHost}`;
  const normalizedPrincipal = principalId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const tag = hashId([principalId], 8).toUpperCase();
  return `VAULT_TOKEN_${normalizedHost}__${normalizedPrincipal}_${tag}`;
}
