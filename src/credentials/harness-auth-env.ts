import type { Keychain } from "./keychain.ts";

/**
 * Resolve a keychain env credential (e.g. a CLAUDE_CODE_OAUTH_TOKEN saved by
 * `claude setup-token`) into the env vars a harness child should receive.
 * Resolved fresh on every call, so a rotated or revoked credential takes
 * effect on the next session with no restart. Returns {} when the credential
 * is missing, expired, or not env-shaped, so the harness falls back to
 * whatever static configuration it has.
 */
export function keychainHarnessAuthEnv(
  keychain: Keychain,
  credentialId: string,
  allowedEnvKeys: readonly string[],
): () => Promise<NodeJS.ProcessEnv> {
  return async () => {
    try {
      const meta = await keychain.getCredential(credentialId);
      if (!meta || meta.kind !== "env") return {};
      if (typeof meta.expiresAt === "number" && meta.expiresAt < Date.now()) return {};
      const creds = await keychain.materializeOwn(meta.ownerId);
      const cred = creds.find((c) => c.credentialId === credentialId);
      if (!cred) return {};
      const env: NodeJS.ProcessEnv = {};
      for (const { key, value } of cred.env) {
        if (allowedEnvKeys.includes(key)) env[key] = value;
      }
      return env;
    } catch {
      return {};
    }
  };
}
