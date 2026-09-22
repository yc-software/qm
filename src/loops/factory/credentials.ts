import type { DecryptedServiceCredential, ServiceCredentialReader } from "../../credentials/keychain.ts";
import type { ScopeId } from "../../types.ts";

export const FACTORY_LINEAR_SLUG = "factory-linear";
export const FACTORY_GITHUB_SLUG = "factory-github";
export const FACTORY_SLACK_SLUG = "factory-slack";

export type FactoryCredentials =
  | { ok: true; linearApiKey: string; githubToken: string; slackBotToken?: string }
  | { ok: false; missing: string[] };

function usableSecret(rec: DecryptedServiceCredential | null): string | null {
  if (!rec || !rec.enabled) return null;
  const secret = rec.secret.trim();
  return secret === "" ? null : secret;
}

export async function readFactoryCredentials(
  reader: ServiceCredentialReader,
  orgScopeId: ScopeId,
  opts: { slack: boolean },
): Promise<FactoryCredentials> {
  const [linearRec, githubRec, slackRec] = await Promise.all([
    reader.getServiceCredentialSecret(orgScopeId, FACTORY_LINEAR_SLUG),
    reader.getServiceCredentialSecret(orgScopeId, FACTORY_GITHUB_SLUG),
    reader.getServiceCredentialSecret(orgScopeId, FACTORY_SLACK_SLUG),
  ]);
  const linearApiKey = usableSecret(linearRec);
  const githubToken = usableSecret(githubRec);
  const slackBotToken = usableSecret(slackRec);
  if (linearApiKey === null || githubToken === null || (opts.slack && slackBotToken === null)) {
    const missing: string[] = [];
    if (linearApiKey === null) missing.push(FACTORY_LINEAR_SLUG);
    if (githubToken === null) missing.push(FACTORY_GITHUB_SLUG);
    if (opts.slack && slackBotToken === null) missing.push(FACTORY_SLACK_SLUG);
    return { ok: false, missing };
  }
  return {
    ok: true,
    linearApiKey,
    githubToken,
    ...(slackBotToken !== null ? { slackBotToken } : {}),
  };
}
