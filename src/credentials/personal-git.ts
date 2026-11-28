import type { KeychainCredential } from "./keychain.ts";

interface PersonalGitRemote {
  host: string;
  username: string;
}

const GITHUB: PersonalGitRemote = { host: "github.com", username: "x-access-token" };

export function personalGitRemote(
  credential: Pick<KeychainCredential, "service" | "kind" | "managed" | "fields" | "envKey">,
): PersonalGitRemote | undefined {
  if (credential.kind !== "env" || credential.managed || credential.fields?.length || !credential.envKey)
    return undefined;
  return credential.service === "github" ? GITHUB : undefined;
}

export function personalGitBasicCredential(remote: PersonalGitRemote, secret: string): string {
  return Buffer.from(`${remote.username}:${secret}`).toString("base64");
}

export function personalCredentialId(handle: string): string | undefined {
  const separator = handle.lastIndexOf(":");
  return separator > 0 ? handle.slice(separator + 1) : undefined;
}
