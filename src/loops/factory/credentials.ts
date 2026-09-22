import type { DecryptedServiceCredential, ServiceCredentialReader } from "../../credentials/keychain.ts";
import type { ScopeId } from "../../types.ts";

export const FACTORY_LINEAR_SLUG = "factory-linear";

export type FactoryCredentials = { ok: true; linearApiKey: string } | { ok: false; missing: string[] };

function usableSecret(rec: DecryptedServiceCredential | null): string | null {
  if (!rec || !rec.enabled) return null;
  const secret = rec.secret.trim();
  return secret === "" ? null : secret;
}

export async function readFactoryCredentials(
  reader: ServiceCredentialReader,
  orgScopeId: ScopeId,
): Promise<FactoryCredentials> {
  const linearApiKey = usableSecret(await reader.getServiceCredentialSecret(orgScopeId, FACTORY_LINEAR_SLUG));
  if (linearApiKey === null) return { ok: false, missing: [FACTORY_LINEAR_SLUG] };
  return { ok: true, linearApiKey };
}
