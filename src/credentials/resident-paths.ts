import { posix } from "node:path";
import { shq } from "../util/shell.ts";

export const BASE_RESIDENT_AUTH_PATHS = [
  ".aws",
  ".config/gh",
  ".config/gcloud",
  ".ssh",
  ".netrc",
  ".git-credentials",
] as const;

export const BASE_EPHEMERAL_CRED_LINKS: ReadonlyArray<{ rel: string; kind: "dir" | "file" }> = [
  { rel: ".aws", kind: "dir" },
  { rel: ".netrc", kind: "file" },
  { rel: ".config/gh", kind: "dir" },
  { rel: ".config/glab", kind: "dir" },
  { rel: ".config/gcloud", kind: "dir" },
];

const DURABLE_CREDENTIAL_PATHS = [".ssh", ".git-credentials"] as const;
export const EPHEMERAL_CRED_DIR = "/tmp/agent-creds";

export interface CredentialPathSpec {
  path: string;
  kind: "file" | "directory";
}

export function residentAuthPaths(extra: readonly CredentialPathSpec[] = []): string[] {
  return [...new Set([...BASE_RESIDENT_AUTH_PATHS, ...extra.map((entry) => entry.path)])];
}

export function credentialServiceForPath(path: string): string | undefined {
  const normalized = path.replace(/^\.\//, "");
  if (normalized.startsWith(".config/")) return normalized.split("/")[1] || undefined;
  const first = normalized.split("/")[0] ?? "";
  return first.startsWith(".") && first.length > 1 ? first.slice(1) : undefined;
}

export function ephemeralCredLinkPaths(
  extra: readonly CredentialPathSpec[] = [],
): Array<{ rel: string; kind: "dir" | "file" }> {
  const links = new Map<string, "dir" | "file">(BASE_EPHEMERAL_CRED_LINKS.map(({ rel, kind }) => [rel, kind]));
  const covered = (path: string): boolean =>
    DURABLE_CREDENTIAL_PATHS.some((base) => path === base || path.startsWith(`${base}/`)) ||
    BASE_EPHEMERAL_CRED_LINKS.some(({ rel }) => path === rel || path.startsWith(`${rel}/`));
  for (const { path, kind } of extra) {
    if (covered(path)) continue;
    if (!links.has(path)) links.set(path, kind === "directory" ? "dir" : "file");
  }
  return [...links].map(([rel, kind]) => ({ rel, kind }));
}

const mkdirHealing = (dir: string): string =>
  `if ! mkdir -p ${shq(dir)} 2>/dev/null; then rm -rf ${shq(dir)}; mkdir -p ${shq(dir)}; fi`;

export function ephemeralCredLinkScript(home: string, extraPaths: readonly CredentialPathSpec[] = []): string {
  const parts = [mkdirHealing(EPHEMERAL_CRED_DIR), `chmod 700 ${shq(EPHEMERAL_CRED_DIR)}`];
  for (const { rel, kind } of ephemeralCredLinkPaths(extraPaths)) {
    const path = posix.join(home, rel);
    const target = posix.join(EPHEMERAL_CRED_DIR, rel);
    parts.push(
      mkdirHealing(posix.dirname(target)),
      `if [ -L ${shq(path)} ] && [ "$(readlink ${shq(path)})" != ${shq(target)} ]; then old="$(readlink -f ${shq(path)} 2>/dev/null || true)"; rm ${shq(path)}; if [ -n "$old" ] && [ -e "$old" ] && [ ! -e ${shq(target)} ]; then mv "$old" ${shq(target)}; fi; fi`,
      `if [ ! -L ${shq(path)} ]; then if [ -e ${shq(path)} ]; then rm -rf ${shq(target)}; mv ${shq(path)} ${shq(target)}; fi; ${mkdirHealing(posix.dirname(path))}; ln -s ${shq(target)} ${shq(path)}; fi`,
    );
    if (kind === "dir") parts.push(mkdirHealing(target));
  }
  return parts.join(" && ");
}

export const EPHEMERAL_CRED_PATHS: ReadonlyArray<{ rel: string; kind: "dir" | "file" }> = ephemeralCredLinkPaths();
