import { fileCredentialFingerprint, type CredentialFile, type Keychain } from "./keychain.ts";
import type { Sandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import { parseTar } from "../sandbox/tar.ts";
import { scopeId, type ScopeId } from "../types.ts";
import { shq } from "../util/shell.ts";
import { EPHEMERAL_CRED_DIR } from "./resident-paths.ts";
import { credentialServiceForPath, type CredentialPathSpec } from "./resident-paths.ts";

const CRED_DOTDIRS = [
  ".aws",
  ".ssh",
  ".docker",
  ".kube",
  ".azure",
  ".gnupg",
  ".fly",
  ".terraform.d",
  ".pulumi",
  ".railway",
  ".oci",
  ".m2",
  ".cargo",
  ".gem",
];
const CRED_DOTFILES = [
  ".netrc",
  ".git-credentials",
  ".pgpass",
  ".npmrc",
  ".terraformrc",
  ".pypirc",
  ".databrickscfg",
  ".my.cnf",
];
const PRUNE_NAMES = ["logs", ".cache", "__pycache__", "node_modules"];
const PRUNE_PATHS = ["*/gcloud/cache", "*/gcloud/logs"];
const MAX_SERVICE_BYTES = 4 * 1024 * 1024;
const MAX_SERVICE_FILES = 500;
const MAX_FILE_BYTES = 1024 * 1024;

export const DEVICE_FLOW_ORIGIN = "device-flow-auto-capture";

export function deviceFlowCredOwner(computerScopeId: ScopeId, actorId: string): string {
  return computerScopeId === scopeId("personal", actorId) ? actorId : computerScopeId;
}

const captureScript = (tmp: string, credentialPaths: readonly CredentialPathSpec[] = []): string => {
  const extraDirs = credentialPaths.filter((entry) => entry.kind === "directory").map((entry) => entry.path);
  const extraFiles = credentialPaths.filter((entry) => entry.kind === "file").map((entry) => entry.path);
  return [
    `cd "$HOME" 2>/dev/null || { : > ${shq(tmp)}; exit 0; }`,
    `set --`,
    `for d in ${[...CRED_DOTDIRS, ...extraDirs].map(shq).join(" ")} .config/*/; do [ -d "$d" ] && set -- "$@" "${"${d%/}"}"; done`,
    `{ [ "$#" -gt 0 ] && find -L "$@" ` +
      `\\( ${[...PRUNE_NAMES.map((n) => `-name ${shq(n)}`), ...PRUNE_PATHS.map((p) => `-path ${shq(p)}`)].join(" -o ")} \\) -prune ` +
      `-o -type f -size -1024k -print0; ` +
      `for f in ${[...CRED_DOTFILES, ...extraFiles].map(shq).join(" ")}; do [ -f "$f" ] && printf '%s\\0' "$f"; done; } ` +
      `2>/dev/null | tar -h --null -T - -cf ${shq(tmp)} 2>/dev/null`,
    `[ -e ${shq(tmp)} ] || : > ${shq(tmp)}`,
  ].join("; ");
};

export interface DeviceFlowPersistInput {
  sandbox: Sandbox;
  handle: SandboxHandle;
  keychain: Keychain;
  ownerId: string;
  onAnomaly?: (service: string, detail: string) => void;
  credentialPaths?: CredentialPathSpec[];
  services?: readonly string[];
  excludeServices?: readonly string[];
}

function rootedAt(handle: SandboxHandle, dir: string): SandboxHandle {
  return { ...handle, rootDir: dir };
}
function homeOf(handle: SandboxHandle): string {
  return handle.homeDir ?? "/root";
}

export async function captureDeviceFlowLogins(input: DeviceFlowPersistInput): Promise<string[]> {
  const made = await input.sandbox.run(input.handle, `mktemp ${shq("/tmp/agent-cred-capture.XXXXXX")}`, {
    timeoutMs: 30_000,
  });
  if (made.code !== 0)
    throw new Error(`device-flow credential read failed: mktemp ${made.stderr || `exit ${made.code}`}`);
  const tmp = made.stdout.trim();
  const dir = tmp.replace(/\/[^/]*$/, "");
  const base = tmp.slice(dir.length + 1);

  let tar: Uint8Array | null;
  try {
    const built = await input.sandbox.run(input.handle, captureScript(tmp, input.credentialPaths), {
      timeoutMs: 60_000,
    });
    if (built.code !== 0)
      throw new Error(`device-flow credential read failed: ${built.stderr || `exit ${built.code}`}`);
    tar = await input.sandbox.readFileBytes(rootedAt(input.handle, dir), base);
  } finally {
    await input.sandbox.run(input.handle, `rm -f ${shq(tmp)}`, { timeoutMs: 30_000 }).catch(() => {});
  }
  if (tar === null) throw new Error("device-flow credential read failed: capture tar unreadable");

  const byService = new Map<string, CredentialFile[]>();
  for (const entry of await parseTar(tar)) {
    const path = entry.path.replace(/^\.\//, "");
    if (entry.data.length >= MAX_FILE_BYTES) continue;
    const service = credentialServiceForPath(path);
    if (!service) continue;
    if (input.services && !input.services.includes(service)) continue;
    if (input.excludeServices?.includes(service)) continue;
    const files = byService.get(service) ?? [];
    files.push({ path, contentBase64: entry.data.toString("base64") });
    byService.set(service, files);
  }

  const existing = new Map(
    (await input.keychain.listByOwner(input.ownerId)).filter((c) => c.kind === "file").map((c) => [c.service, c]),
  );
  const saved: string[] = [];
  for (const [service, files] of byService) {
    const bytes = files.reduce((n, f) => n + Math.floor((f.contentBase64.length * 3) / 4), 0);
    if (files.length > MAX_SERVICE_FILES || bytes > MAX_SERVICE_BYTES) {
      input.onAnomaly?.(service, `${files.length} files / ${bytes} bytes exceeds capture caps`);
      continue;
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const prior = existing.get(service);
    if (prior?.fingerprint === fileCredentialFingerprint(files)) continue;
    await input.keychain.save({
      ownerId: input.ownerId,
      service,
      files,
      origin: DEVICE_FLOW_ORIGIN,
    });
    saved.push(service);
  }
  return saved;
}

export async function materializeDeviceFlowLogins(input: DeviceFlowPersistInput): Promise<string[]> {
  const bundles = (await input.keychain.materializeOwnFiles(input.ownerId)).filter(
    (b) =>
      b.origin === DEVICE_FLOW_ORIGIN &&
      (!input.services || input.services.includes(b.service)) &&
      !input.excludeServices?.includes(b.service),
  );
  if (!bundles.length) return [];

  const candidates = [...new Set(bundles.flatMap((b) => b.files.map((f) => f.path)))];

  const home = homeOf(input.handle);
  const probe = await input.sandbox.run(
    input.handle,
    `cd "$HOME" 2>/dev/null || exit 0; for p in ${candidates.map(shq).join(" ")}; do [ -e "$p" ] && printf '%s\\0' "$p"; done; :`,
    { timeoutMs: 60_000 },
  );
  if (probe.code !== 0)
    throw new Error(`device-flow credential restore failed: ${probe.stderr || `exit ${probe.code}`}`);
  const present = new Set(probe.stdout.split("\0").filter(Boolean));

  const homeHandle = rootedAt(input.handle, home);
  const wrote: string[] = [];
  const wroteServices = new Set<string>();
  for (const bundle of bundles) {
    for (const f of bundle.files) {
      if (present.has(f.path)) continue;
      await input.sandbox.writeFileBytes(homeHandle, f.path, Buffer.from(f.contentBase64, "base64"));
      present.add(f.path);
      wrote.push(f.path);
      wroteServices.add(bundle.service);
    }
  }
  if (wrote.length) {
    await input.sandbox
      .run(
        input.handle,
        `cd "$HOME" 2>/dev/null || exit 0; for p in ${wrote.map(shq).join(" ")}; do [ -e "$p" ] && chmod 600 "$p"; done`,
        { timeoutMs: 60_000 },
      )
      .catch(() => {});
  }
  return [...wroteServices];
}

export async function removeDeviceFlowLogins(
  input: Pick<DeviceFlowPersistInput, "sandbox" | "handle" | "keychain" | "ownerId" | "services"> & {
    allOrigins?: boolean;
    canonicalRoots?: readonly string[];
  },
): Promise<string[]> {
  if (!input.services?.length) return [];
  const services = new Set(input.services);
  const records = (await input.keychain.listByOwner(input.ownerId)).filter(
    (record) =>
      record.kind === "file" &&
      (input.allOrigins || record.origin === DEVICE_FLOW_ORIGIN) &&
      services.has(record.service),
  );
  const canonicalRoots = [...(input.canonicalRoots ?? [])];
  const paths = [
    ...new Set([
      ...canonicalRoots,
      ...records.flatMap((record) => record.targets ?? (record.target ? [record.target] : [])),
    ]),
  ];
  if (!paths.length) return [];
  const removed = await input.sandbox.run(
    input.handle,
    `cd "$HOME" 2>/dev/null || exit 0; for p in ${canonicalRoots.map(shq).join(" ")}; do if [ -L "$p" ]; then target="$(readlink -- "$p" 2>/dev/null || true)"; case "$target" in ${shq(`${EPHEMERAL_CRED_DIR}/`)}*) rm -rf -- "$target" ;; esac; fi; done; rm -rf -- ${paths.map(shq).join(" ")}`,
    { timeoutMs: 60_000 },
  );
  if (removed.code !== 0) {
    throw new Error(`device-flow credential quarantine failed: ${removed.stderr || `exit ${removed.code}`}`);
  }
  return paths;
}
