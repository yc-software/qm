import { posix } from "node:path";
import { shq } from "../util/shell.ts";
import { pathUnder } from "../util/paths.ts";
import { homeRelativePath } from "./paths.ts";

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
  { rel: ".config/glab-cli", kind: "dir" },
  { rel: ".config/gcloud", kind: "dir" },
];

const DURABLE_CREDENTIAL_PATHS = [".ssh", ".git-credentials"] as const;
export const EPHEMERAL_CRED_DIR = "/tmp/agent-creds";

//

export const DISPLACED_DIR_REL = ".agent-displaced";

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

export function captureRootForTarget(target: string): CredentialPathSpec | undefined {
  let normalized: string;
  try {
    normalized = homeRelativePath(target);
  } catch {
    return undefined;
  }
  if (!credentialServiceForPath(normalized)) return undefined;
  const segments = normalized.split("/");
  if (normalized.startsWith(".config/") && segments.length > 2)
    return { path: `.config/${segments[1]}`, kind: "directory" };
  return { path: normalized, kind: "file" };
}

export function configCredentialDirs(): string[] {
  return BASE_EPHEMERAL_CRED_LINKS.filter((l) => l.rel.startsWith(".config/")).map((l) => l.rel);
}

export const CREDENTIAL_PATH_RE = /^[A-Za-z0-9._/@+-]+$/;

export function builtInCredentialPaths(): CredentialPathSpec[] {
  return [
    ...BASE_EPHEMERAL_CRED_LINKS.map(({ rel, kind }) => ({
      path: rel,
      kind: kind === "dir" ? ("directory" as const) : ("file" as const),
    })),
    { path: ".ssh", kind: "directory" },
    { path: ".git-credentials", kind: "file" },
  ];
}

const SERVICE_ALIASES: Readonly<Record<string, readonly string[]>> = { glab: ["glab-cli"] };

export function expandServiceAliases(services: readonly string[]): string[] {
  return [...new Set(services.flatMap((s) => [s, ...(SERVICE_ALIASES[s] ?? [])]))];
}

export function displacedPruneGlobs(): string[] {
  return [`./${DISPLACED_DIR_REL}`, `./${DISPLACED_DIR_REL}/*`, `./${DISPLACED_DIR_REL}.*`];
}

export function ephemeralCredLinkPaths(
  extra: readonly CredentialPathSpec[] = [],
): Array<{ rel: string; kind: "dir" | "file" }> {
  const links = new Map<string, "dir" | "file">(BASE_EPHEMERAL_CRED_LINKS.map(({ rel, kind }) => [rel, kind]));
  const covered = (path: string): boolean =>
    DURABLE_CREDENTIAL_PATHS.some((base) => pathUnder(path, base)) ||
    BASE_EPHEMERAL_CRED_LINKS.some(({ rel }) => pathUnder(path, rel));
  for (const { path, kind } of extra) {
    if (covered(path)) continue;
    if (!links.has(path)) links.set(path, kind === "directory" ? "dir" : "file");
  }
  return [...links].map(([rel, kind]) => ({ rel, kind }));
}

const mkdirHealing = (dir: string): string => {
  if (dir !== EPHEMERAL_CRED_DIR && !dir.startsWith(`${EPHEMERAL_CRED_DIR}/`))
    throw new Error(`refusing destructive mkdir healing outside ${EPHEMERAL_CRED_DIR}: ${dir}`);
  return `if ! mkdir -p ${shq(dir)} 2>/dev/null; then rm -rf ${shq(dir)}; mkdir -p ${shq(dir)}; fi`;
};

const QUARANTINE_RETENTION_DAYS = 7;

const healQuarantine = (dir: string): string =>
  `if ! mkdir -p ${dir} 2>/dev/null || [ -L ${dir} ]; then recovery=${dir}.$$.$(date +%s); while [ -e "$recovery" ] || [ -L "$recovery" ]; do recovery="$recovery.x"; done; if [ -L ${dir} ]; then target=$(readlink ${dir}) && ln -s "$target" "$recovery" || [ ! -L ${dir} ] || exit 1; elif [ -d ${dir} ]; then :; elif [ -e ${dir} ]; then ln ${dir} "$recovery" || { [ ! -e ${dir} ] || [ -d ${dir} ]; } || exit 1; fi; if [ -L ${dir} ] || [ ! -d ${dir} ]; then rm -f ${dir} 2>/dev/null || { [ -d ${dir} ] && [ ! -L ${dir} ]; } || exit 1; mkdir -p ${dir}; fi; fi`;

const displace = (home: string, rel: string, convergedTarget?: string): string => {
  const quarantine = posix.join(home, DISPLACED_DIR_REL);
  const aside = posix.join(quarantine, rel);
  const src = posix.join(home, rel);

  const cleanup = convergedTarget
    ? `if [ -L "$displaced_path" ] && [ "$(readlink "$displaced_path")" = ${shq(convergedTarget)} ]; then rm -f "$displaced_path"; fi`
    : ":";
  const movedByPeer = convergedTarget
    ? `[ ! -e ${shq(src)} ] || { [ -L ${shq(src)} ] && [ "$(readlink ${shq(src)} 2>/dev/null)" = ${shq(convergedTarget)} ]; }`
    : `[ ! -e ${shq(src)} ]`;
  return [
    healQuarantine(shq(quarantine)),
    `find ${shq(quarantine)} -mindepth 1 -maxdepth 1 -mtime +${QUARANTINE_RETENTION_DAYS} -exec rm -rf {} + 2>/dev/null`,
    `mkdir -p ${shq(posix.dirname(aside))}`,
    `displaced_path=${shq(aside)}.$$.$(date +%s); if mv ${shq(src)} "$displaced_path"; then ${cleanup}; else ${movedByPeer}; fi`,
  ].join("; ");
};

const linkOrConverge = (path: string, target: string): string =>
  `for attempt in 1 2 3 4; do ln -s ${shq(target)} ${shq(path)} && break; [ "$(readlink ${shq(path)} 2>/dev/null)" = ${shq(target)} ] && break; [ "$attempt" != 4 ] && [ ! -e ${shq(path)} ] && [ ! -L ${shq(path)} ] || exit 1; done`;

const mkdirDisplacing = (home: string, rel: string): string => {
  if (rel === ".") return `mkdir -p ${shq(home)}`;
  const dir = shq(posix.join(home, rel));
  return `if [ ! -d ${dir} ]; then if [ -e ${dir} ] || [ -L ${dir} ]; then ${displace(home, rel)}; fi; mkdir -p ${dir}; fi`;
};

export function ephemeralCredLinkScript(home: string, extraPaths: readonly CredentialPathSpec[] = []): string {
  const parts = [mkdirHealing(EPHEMERAL_CRED_DIR), `chmod 700 ${shq(EPHEMERAL_CRED_DIR)}`];
  for (const { rel, kind } of ephemeralCredLinkPaths(extraPaths)) {
    const path = posix.join(home, rel);
    const target = posix.join(EPHEMERAL_CRED_DIR, rel);
    parts.push(
      mkdirHealing(posix.dirname(target)),

      `if [ -L ${shq(path)} ] && [ "$(readlink ${shq(path)})" != ${shq(target)} ]; then rm -f ${shq(path)}; fi`,
      `if [ ! -L ${shq(path)} ]; then if [ -e ${shq(path)} ]; then ${displace(home, rel, target)}; fi; ${mkdirDisplacing(home, posix.dirname(rel))}; ${linkOrConverge(path, target)}; fi`,
    );
    if (kind === "dir") parts.push(mkdirHealing(target));
  }
  return parts.join(" && ");
}

export const EPHEMERAL_CRED_PATHS: ReadonlyArray<{ rel: string; kind: "dir" | "file" }> = ephemeralCredLinkPaths();
