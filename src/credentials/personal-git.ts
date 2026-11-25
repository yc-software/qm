import type { KeychainCredential } from "./keychain.ts";

interface PersonalGitRemote {
  host: string;
  username: string;
}

const PERSONAL_GIT_REMOTES: ReadonlyMap<string, PersonalGitRemote> = new Map([
  ["github", { host: "github.com", username: "x-access-token" }],
  ["gitlab", { host: "gitlab.com", username: "oauth2" }],
]);

export function personalGitRemote(
  credential: Pick<KeychainCredential, "service" | "kind" | "managed" | "fields" | "envKey">,
): PersonalGitRemote | undefined {
  if (credential.kind !== "env" || credential.managed || credential.fields?.length || !credential.envKey)
    return undefined;
  return PERSONAL_GIT_REMOTES.get(credential.service);
}

export function personalGitBasicCredential(remote: PersonalGitRemote, secret: string): string {
  return Buffer.from(`${remote.username}:${secret}`).toString("base64");
}

export function personalCredentialId(handle: string): string | undefined {
  const separator = handle.lastIndexOf(":");
  return separator > 0 ? handle.slice(separator + 1) : undefined;
}
