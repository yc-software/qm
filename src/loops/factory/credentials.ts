import type { DecryptedServiceCredential, ServiceCredentialReader } from "../../credentials/keychain.ts";
import type { ScopeId } from "../../types.ts";

export const FACTORY_LINEAR_SLUG = "factory-linear";
export const FACTORY_GITHUB_SLUG = "factory-github";
// The wrapper runs `claude -p` inside the sandbox, so the model key must travel with the other two.
export const FACTORY_ANTHROPIC_SLUG = "factory-anthropic";

export type FactoryCredentials =
  { ok: true; linearApiKey: string; githubToken: string; anthropicApiKey: string } | { ok: false; missing: string[] };

function usableSecret(rec: DecryptedServiceCredential | null): string | null {
  if (!rec || !rec.enabled) return null;
  const secret = rec.secret.trim();
  return secret === "" ? null : secret;
}

export async function readFactoryCredentials(
  reader: ServiceCredentialReader,
  orgScopeId: ScopeId,
): Promise<FactoryCredentials> {
  const [linearRec, githubRec, anthropicRec] = await Promise.all([
    reader.getServiceCredentialSecret(orgScopeId, FACTORY_LINEAR_SLUG),
    reader.getServiceCredentialSecret(orgScopeId, FACTORY_GITHUB_SLUG),
    reader.getServiceCredentialSecret(orgScopeId, FACTORY_ANTHROPIC_SLUG),
  ]);
  const linearApiKey = usableSecret(linearRec);
  const githubToken = usableSecret(githubRec);
  const anthropicApiKey = usableSecret(anthropicRec);
  if (linearApiKey === null || githubToken === null || anthropicApiKey === null) {
    const missing: string[] = [];
    if (linearApiKey === null) missing.push(FACTORY_LINEAR_SLUG);
    if (githubToken === null) missing.push(FACTORY_GITHUB_SLUG);
    if (anthropicApiKey === null) missing.push(FACTORY_ANTHROPIC_SLUG);
    return { ok: false, missing };
  }
  return { ok: true, linearApiKey, githubToken, anthropicApiKey };
}
