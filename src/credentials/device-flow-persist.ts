import {
  DEVICE_FLOW_ORIGIN,
  KeychainError,
  fileCredentialFingerprint,
  restoredFileMode,
  type CredentialFile,
  type Keychain,
} from "./keychain.ts";
import { errMessage } from "../util/errors.ts";
import { pathUnder } from "../util/paths.ts";
import type { Sandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import { makeTar, parseTar } from "../sandbox/tar.ts";
import { scopeId, type ScopeId } from "../types.ts";
import { shq } from "../util/shell.ts";
import { hashId } from "../util/crypto.ts";
import { DISPLACED_DIR_REL, EPHEMERAL_CRED_DIR } from "./resident-paths.ts";
import {
  CREDENTIAL_PATH_RE,
  builtInCredentialPaths,
  captureRootForTarget,
  configCredentialDirs,
  credentialServiceForPath,
  expandServiceAliases,
  type CredentialPathSpec,
} from "./resident-paths.ts";
import { credentialPathError } from "../deployment/deployment-layer.ts";
import { homeRelativePath } from "./paths.ts";

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
const MAX_REGISTERED_ROOTS = 64;

export { DEVICE_FLOW_ORIGIN };

export function deviceFlowCredOwner(computerScopeId: ScopeId, actorId: string): string {
  return computerScopeId === scopeId("personal", actorId) ? actorId : computerScopeId;
}

function fixedCoverage(credentialPaths: readonly CredentialPathSpec[]): { dirs: Set<string>; files: Set<string> } {
  const dirs = new Set<string>([...CRED_DOTDIRS, ...configCredentialDirs()]);
  const files = new Set<string>(CRED_DOTFILES);
  for (const entry of credentialPaths) {
    if (entry.kind === "directory") dirs.add(entry.path);
    else files.add(entry.path);
  }
  return { dirs, files };
}

function isCovered(root: CredentialPathSpec, fixed: { dirs: Set<string>; files: Set<string> }): boolean {
  if ([...fixed.dirs].some((d) => pathUnder(root.path, d))) return true;
  return root.kind === "file" && fixed.files.has(root.path);
}

const pruneExpr = (): string =>
  `\\( ${[...PRUNE_NAMES.map((n) => `-name ${shq(n)}`), ...PRUNE_PATHS.map((p) => `-path ${shq(p)}`)].join(" -o ")} \\) -prune`;

interface SweepGroup {
  service: string;
  dirs: string[];
  files: string[];
}

const SWEEP_PATH_RE = CREDENTIAL_PATH_RE;
const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const CRED_WORK_DIR = DISPLACED_DIR_REL;
const CAPTURE_STATE_REL = ".cred-state";
const credTransientReaper = (excludeGlob?: string): string =>
  `find "$HOME/${CRED_WORK_DIR}" -maxdepth 1 -name '.cred-*'${excludeGlob ? ` ! -name ${shq(excludeGlob)}` : ""} -mmin +60 -exec rm -rf {} + 2>/dev/null; ` +
  `find "$HOME" -maxdepth 1 \\( -name '.agent-cred-*' -o \\( -name '${CAPTURE_STATE_REL}.w.*' -mmin +60 \\) \\) -exec rm -rf {} + 2>/dev/null`;
const ensureCredWorkDir = `{ mkdir -p "$HOME/${CRED_WORK_DIR}" 2>/dev/null && [ ! -L "$HOME/${CRED_WORK_DIR}" ] && [ -d "$HOME/${CRED_WORK_DIR}" ]; }`;

const groupHashLines = (group: SweepGroup): string[] => [
  `h=""`,
  ...group.dirs.map((d) => `[ -d ${shq(d)} ] && h="$h $(qmhd ${shq(d)})"`),
  ...group.files.map((f) => `[ -f ${shq(f)} ] && h="$h $(qmhf ${shq(f)})"`),
];

const captureScript = (groups: readonly SweepGroup[], gate: boolean): string => {
  const size = `-size -${MAX_FILE_BYTES}c`;
  const st = `"$HOME/${CAPTURE_STATE_REL}"`;
  const lines: string[] = [
    `if command -v sha256sum >/dev/null 2>&1; then QSH="sha256sum"; elif command -v shasum >/dev/null 2>&1; then QSH="shasum -a 256"; else QSH="cksum"; fi`,
    `if stat -c '%a' / >/dev/null 2>&1; then QST="stat -c %a:%n"; else QST="stat -f %Lp:%N"; fi`,
    `qmsha() { $QSH | cut -d" " -f1; }`,
    `qmhd() { ql=$(mktemp "$HOME/${CRED_WORK_DIR}/.cred-list.XXXXXX") || { printf 'ERR-%s-%s' "$$" "$(date +%s)"; return 0; }; ` +
      `find -L "$1" ${pruneExpr()} -o -type f ${size} -print0 2>/dev/null | LC_ALL=C sort -z > "$ql"; ` +
      `[ -s "$ql" ] || { rm -f "$ql"; return 0; }; ` +
      `{ xargs -0 $QSH < "$ql" 2>/dev/null; xargs -0 $QST < "$ql" 2>/dev/null; } | qmsha; rm -f "$ql"; }`,
    `qmhf() { [ -n "$(find -L "$1" -maxdepth 0 -type f ${size} 2>/dev/null)" ] || return 0; { find -L "$1" -maxdepth 0 -type f ${size} -print0 2>/dev/null | xargs -0 $QSH 2>/dev/null; $QST "$1" 2>/dev/null; } | qmsha; }`,
    `cd "$HOME" 2>/dev/null || { printf 'NOHOME\\tcd\\n'; exit 0; }`,
    `${ensureCredWorkDir} || { printf 'NOHOME\\tworkdir\\n'; exit 0; }`,
    `${credTransientReaper()}`,
    `grep '^!' ${st} 2>/dev/null | while IFS= read -r n; do printf 'ANOTE\\t%s\\n' "$n"; done; :`,
    `t=$(mktemp "$HOME/${CRED_WORK_DIR}/.cred-capture.XXXXXX") || { printf 'NOHOME\\tmktemp\\n'; exit 0; }`,
    `set --`,
    `cf=""`,
  ];
  groups.forEach((group, i) => {
    const svc = shq(group.service);
    lines.push(
      ...groupHashLines(group),
      `hs=$(printf '%s' "$h" | tr -d ' ')`,
      `if [ -n "$hs" ]; then printf 'PRE\\t%s\\t%s\\n' ${svc} "$h"; ` +
        (gate
          ? `if grep -qxF "${group.service}\t$h" ${st} 2>/dev/null; then printf 'KEEP\\t%s\\n' ${svc}; else `
          : "") +
        `printf 'SHIP\\t%s\\n' ${svc}; s${i}=1; p${i}="$h"; ` +
        group.dirs.map((d) => `{ [ -d ${shq(d)} ] && set -- "$@" ${shq(d)}; }; `).join("") +
        group.files.map((f) => `{ [ -f ${shq(f)} ] && cf="$cf ${f}"; }; `).join("") +
        (gate ? `fi; ` : "") +
        `fi`,
    );
  });
  lines.push(
    `{ [ "$#" -gt 0 ] && find -L "$@" ${pruneExpr()} -o -type f ${size} -print0; ` +
      `[ -n "$cf" ] && find -L $cf -maxdepth 0 -type f ${size} -print0; :; } ` +
      `2>/dev/null | LC_ALL=C sort -z | tar -h --null -T - -cf "$t" 2>/dev/null`,
    `[ -e "$t" ] || : > "$t"`,
  );
  groups.forEach((group, i) => {
    lines.push(
      `if [ -n "$s${i}" ]; then ${groupHashLines(group).join("; ")}; ` +
        `[ "$h" = "$p${i}" ] || printf 'VOLATILE\\t%s\\n' ${shq(group.service)}; fi`,
    );
  });
  lines.push(`printf 'TMP\\t%s\\n' "$t"`);
  return lines.join("\n");
};

export interface DeviceFlowPersistInput {
  sandbox: Sandbox;
  handle: SandboxHandle;
  keychain: Keychain;
  ownerId: string;
  onAnomaly?: (service: string, detail: string) => void;
  credentialPaths?: CredentialPathSpec[];
  groupAs?: { service: string; paths: readonly CredentialPathSpec[] };
  services?: readonly string[];
  excludeServices?: readonly string[];
}

function serviceSelected(
  input: Pick<DeviceFlowPersistInput, "services" | "excludeServices">,
  service: string,
): boolean {
  if (input.services && !expandServiceAliases(input.services).includes(service)) return false;
  return !input.excludeServices || !expandServiceAliases(input.excludeServices).includes(service);
}

function rootedAt(handle: SandboxHandle, dir: string): SandboxHandle {
  return { ...handle, rootDir: dir };
}
function homeOf(handle: SandboxHandle): string {
  return handle.homeDir ?? "/root";
}

interface CapturedRecordShape {
  service: string;
  origin?: string;
  targets?: string[];
  target?: string;
  capturePaths?: CredentialPathSpec[];
}

function recordCaptureRoots(
  rec: Pick<CapturedRecordShape, "targets" | "target" | "capturePaths">,
): CredentialPathSpec[] {
  const derived = (rec.targets ?? (rec.target ? [rec.target] : []))
    .map(captureRootForTarget)
    .filter((r): r is CredentialPathSpec => r !== undefined);
  return [...new Map([...(rec.capturePaths ?? []), ...derived].map((r) => [r.path, r] as const)).values()];
}

function buildSweepGroups(
  input: DeviceFlowPersistInput,
  existing: ReadonlyMap<string, CapturedRecordShape>,
): { groups: SweepGroup[]; droppedServices: string[]; deferredAnomalies: Array<[string, string]> } {
  const groups = new Map<string, SweepGroup>();
  const deferredAnomalies: Array<[string, string]> = [];
  const addRoot = (service: string, root: CredentialPathSpec): void => {
    if (!serviceSelected(input, service)) return;
    if (!SERVICE_NAME_RE.test(service)) {
      deferredAnomalies.push([service.slice(0, 64), "service name cannot ride the capture sweep — not swept"]);
      return;
    }
    if (!SWEEP_PATH_RE.test(root.path)) {
      deferredAnomalies.push([
        service,
        `path ${JSON.stringify(root.path)} has characters the sweep cannot carry — not swept`,
      ]);
      return;
    }
    const group = groups.get(service) ?? { service, dirs: [], files: [] };
    const list = root.kind === "directory" ? group.dirs : group.files;
    if (!list.includes(root.path)) list.push(root.path);
    groups.set(service, group);
  };
  for (const dir of [...CRED_DOTDIRS, ...configCredentialDirs()]) {
    const service = credentialServiceForPath(dir);
    if (service) addRoot(service, { path: dir, kind: "directory" });
  }
  for (const file of CRED_DOTFILES) {
    const service = credentialServiceForPath(file);
    if (service) addRoot(service, { path: file, kind: "file" });
  }
  for (const entry of input.credentialPaths ?? []) {
    const service = credentialServiceForPath(entry.path);
    if (service) addRoot(service, entry);
  }
  if (input.groupAs) for (const entry of input.groupAs.paths) addRoot(input.groupAs.service, entry);

  const fixed = fixedCoverage(input.credentialPaths ?? []);
  const droppedServices: string[] = [];
  let registeredCount = 0;
  for (const rec of [...existing.values()].sort((a, b) => a.service.localeCompare(b.service))) {
    if (rec.origin !== DEVICE_FLOW_ORIGIN || !serviceSelected(input, rec.service)) continue;
    const uncovered = recordCaptureRoots(rec).filter((r) => !isCovered(r, fixed));
    const roots = uncovered.filter((r) => {
      if (SWEEP_PATH_RE.test(r.path)) return true;
      deferredAnomalies.push([
        rec.service,
        `stored path ${JSON.stringify(r.path)} has characters the sweep cannot carry — not swept`,
      ]);
      return false;
    });
    if (!roots.length) continue;
    if (registeredCount + roots.length > MAX_REGISTERED_ROOTS) {
      droppedServices.push(rec.service);
      continue;
    }
    registeredCount += roots.length;
    for (const root of roots) addRoot(rec.service, root);
  }

  const ordered = [...groups.values()].sort((a, b) => a.service.localeCompare(b.service));
  const claimed = new Map<string, string>();
  for (const group of ordered) {
    for (const root of [...group.dirs, ...group.files]) if (!claimed.has(root)) claimed.set(root, group.service);
  }
  for (const group of ordered) {
    const foreign = (p: string): boolean => {
      const owner = [...claimed].find(([root, service]) => service !== group.service && pathUnder(p, root));
      if (!owner) return false;
      deferredAnomalies.push([
        group.service,
        `path ${p} overlaps a root owned by ${owner[1]} — swept under ${owner[1]}, not ${group.service}`,
      ]);
      return true;
    };
    group.dirs = group.dirs.filter((d) => !foreign(d) && !group.dirs.some((o) => o !== d && pathUnder(d, o)));
    group.files = group.files.filter((f) => !foreign(f) && !group.dirs.some((d) => pathUnder(f, d)));
  }
  return { groups: ordered.filter((g) => g.dirs.length || g.files.length), droppedServices, deferredAnomalies };
}

export async function captureDeviceFlowLogins(input: DeviceFlowPersistInput): Promise<string[]> {
  const existing = new Map(
    (await input.keychain.listByOwner(input.ownerId)).filter((c) => c.kind === "file").map((c) => [c.service, c]),
  );
  const { groups, droppedServices, deferredAnomalies } = buildSweepGroups(input, existing);
  if (droppedServices.length) {
    input.onAnomaly?.(
      "capture-sweep",
      `${droppedServices.length} services past the ${MAX_REGISTERED_ROOTS}-root sweep cap were not captured: ${droppedServices.join(", ")}`,
    );
  }
  const droppedSet = new Set(droppedServices);
  const gate = !input.groupAs && !input.services;
  const home = homeOf(input.handle);
  const homeHandle = rootedAt(input.handle, home);
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const scriptRel = `${CRED_WORK_DIR}/.cred-capture-${token}.sh`;
  await input.sandbox.writeFileBytes(homeHandle, scriptRel, Buffer.from(captureScript(groups, gate), "utf8"));

  let tmpRel = "";
  const pre = new Map<string, string>();
  const kept = new Set<string>();
  const shipped = new Set<string>();
  const volatile = new Set<string>();
  const priorNotes = new Set<string>();
  const cleanup = async (): Promise<void> => {
    await input.sandbox
      .run(
        input.handle,
        `cd "$HOME" 2>/dev/null || exit 0; rm -f ${shq(scriptRel)}${tmpRel ? ` ${shq(tmpRel)}` : ""}; :`,
        {
          timeoutMs: 30_000,
        },
      )
      .catch(() => {});
  };
  const tar = await (async () => {
    try {
      const built = await input.sandbox.run(input.handle, `sh "$HOME/${scriptRel}"`, { timeoutMs: 120_000 });
      if (built.code !== 0)
        throw new Error(`device-flow credential read failed: ${built.stderr || `exit ${built.code}`}`);
      let tmpAbs = "";
      let noHome = "";
      for (const line of built.stdout.split("\n")) {
        const [tag, a, b] = line.split("\t");
        if (tag === "PRE" && a && b !== undefined) pre.set(a, b);
        else if (tag === "KEEP" && a) kept.add(a);
        else if (tag === "SHIP" && a) shipped.add(a);
        else if (tag === "VOLATILE" && a) volatile.add(a);
        else if (tag === "TMP" && a) tmpAbs = a.trim();
        else if (tag === "ANOTE" && a !== undefined) priorNotes.add(a);
        else if (tag === "NOHOME") noHome = a || "unknown";
      }
      if (noHome === "cd") return null;
      if (noHome) throw new Error(`device-flow credential read failed: capture workspace unavailable (${noHome})`);
      if (!tmpAbs) throw new Error("device-flow credential read failed: capture produced no archive");
      tmpRel = `${CRED_WORK_DIR}/${tmpAbs.slice(tmpAbs.lastIndexOf("/") + 1)}`;
      const read = await input.sandbox.readFileBytes(homeHandle, tmpRel);
      if (read === null) throw new Error("device-flow credential read failed: capture tar unreadable");
      return read;
    } catch (err) {
      await cleanup();
      throw err;
    }
  })();
  if (tar === null) {
    await cleanup();
    return [];
  }
  for (const service of volatile) {
    input.onAnomaly?.(service, "files changed while being captured — skipped this turn, retrying next turn");
  }
  const noteSig = ([service, detail]: [string, string]): string => `!${hashId([service, detail])}`;
  const emitDeferred = (): void => {
    for (const entry of deferredAnomalies) {
      if (!priorNotes.has(noteSig(entry))) input.onAnomaly?.(entry[0], entry[1]);
    }
  };

  const saved: string[] = [];
  try {
    const groupFor = (path: string): string | undefined =>
      groups.find((g) => g.dirs.some((d) => pathUnder(path, d)) || g.files.some((f) => pathUnder(path, f)))?.service;
    const byService = new Map<string, CredentialFile[]>();
    for (const entry of await parseTar(tar)) {
      const path = entry.path.replace(/^\.\//, "");
      if (entry.data.length >= MAX_FILE_BYTES) continue;
      const service = groupFor(path) ?? credentialServiceForPath(path);
      if (!service || !serviceSelected(input, service)) continue;
      if (/[\n\r]/.test(path)) {
        input.onAnomaly?.(service, `captured file name contains a line break — dropped: ${JSON.stringify(path)}`);
        continue;
      }
      const files = byService.get(service) ?? [];
      files.push({
        path,
        contentBase64: entry.data.toString("base64"),
        ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
      });
      byService.set(service, files);
    }

    const resolved = new Set<string>();
    for (const [service, files] of byService) {
      if (droppedSet.has(service) || volatile.has(service)) continue;
      const bytes = files.reduce((n, f) => n + Math.floor((f.contentBase64.length * 3) / 4), 0);
      if (files.length > MAX_SERVICE_FILES || bytes > MAX_SERVICE_BYTES) {
        input.onAnomaly?.(service, `${files.length} files / ${bytes} bytes exceeds capture caps`);
        resolved.add(service);
        continue;
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
      if (existing.get(service)?.fingerprint === fileCredentialFingerprint(files)) {
        resolved.add(service);
        continue;
      }
      try {
        await input.keychain.save({
          ownerId: input.ownerId,
          service,
          files,
          origin: DEVICE_FLOW_ORIGIN,
          expectedOrigin: DEVICE_FLOW_ORIGIN,
        });
      } catch (e) {
        if (e instanceof KeychainError && e.status === 409) {
          resolved.add(service);
          continue;
        }
        if (e instanceof KeychainError && e.status === 503) {
          input.onAnomaly?.(service, "keychain write raced a concurrent save — retrying next turn");
          continue;
        }
        throw e;
      }
      resolved.add(service);
      saved.push(service);
    }
    for (const service of shipped) {
      if (byService.has(service) || volatile.has(service) || droppedSet.has(service)) continue;
      deferredAnomalies.push([service, "shipped by the sweep but produced no capturable files"]);
    }

    emitDeferred();
    if (gate) {
      const committed = [...pre]
        .filter(
          ([service, hash]) =>
            !hash.includes("ERR-") && (kept.has(service) || (shipped.has(service) && resolved.has(service))),
        )
        .map(([service, hash]) => `${service}\t${hash}\n`)
        .join("")
        .concat(deferredAnomalies.map((entry) => `${noteSig(entry)}\n`).join(""));
      try {
        const stateWriteRel = `${CAPTURE_STATE_REL}.w.${hashId([committed, String(Date.now()), String(Math.random())]).slice(0, 12)}`;
        await input.sandbox.writeFileBytes(homeHandle, stateWriteRel, Buffer.from(committed, "utf8"));
        const commit = await input.sandbox.run(
          input.handle,
          `cd "$HOME" 2>/dev/null || exit 1; mv -f ${shq(stateWriteRel)} ${shq(CAPTURE_STATE_REL)} && rm -f ${shq(scriptRel)} ${shq(tmpRel)}`,
          { timeoutMs: 30_000 },
        );
        if (commit.code !== 0) throw new Error(commit.stderr || `exit ${commit.code}`);
      } catch (e) {
        input.onAnomaly?.("capture-state", `state commit failed — next turn re-ships everything: ${errMessage(e)}`);
        await cleanup();
      }
    } else {
      await cleanup();
    }
  } catch (err) {
    await cleanup();
    throw err;
  }
  return saved;
}

const MAX_REGISTER_PATHS = 16;

export interface RegisterLoginInput {
  sandbox: Sandbox;
  handle: SandboxHandle;
  keychain: Keychain;
  ownerId: string;
  service: string;
  paths: CredentialPathSpec[];
  onAnomaly?: (service: string, detail: string) => void;
}

export async function registerLoginPaths(input: RegisterLoginInput): Promise<{ service: string; captured: boolean }> {
  const service = input.service.trim().toLowerCase();
  if (!SERVICE_NAME_RE.test(service))
    throw new KeychainError(400, `invalid service name ${JSON.stringify(input.service)}`);
  if (!input.paths.length) throw new KeychainError(400, "register_login needs at least one path");
  if (input.paths.length > MAX_REGISTER_PATHS)
    throw new KeychainError(400, `register_login accepts at most ${MAX_REGISTER_PATHS} paths`);
  const records = (await input.keychain.listByOwner(input.ownerId)).filter((c) => c.kind === "file");
  const normalized: CredentialPathSpec[] = [];
  for (const entry of input.paths) {
    let path: string;
    try {
      path = homeRelativePath(entry.path);
    } catch {
      throw new KeychainError(400, `path ${JSON.stringify(entry.path)} must be under $HOME with no traversal`);
    }
    const err = credentialPathError(path, entry.kind);
    if (err) throw new KeychainError(400, err);
    if (path === CAPTURE_STATE_REL || path.startsWith(`${CAPTURE_STATE_REL}.`) || pathUnder(path, CRED_WORK_DIR))
      throw new KeychainError(400, `path ${JSON.stringify(path)} is capture bookkeeping, not a credential`);
    const coveredDir = [...builtInCredentialPaths().map((b) => b.path), ...CRED_DOTDIRS].find(
      (base) => pathUnder(path, base) || pathUnder(base, path),
    );
    if (coveredDir || CRED_DOTFILES.includes(path)) {
      const autoService = credentialServiceForPath(path);
      if (autoService && records.some((r) => expandServiceAliases([autoService]).includes(r.service)))
        throw new KeychainError(
          409,
          `path ${JSON.stringify(path)} is already captured automatically as ${JSON.stringify(autoService)} — no registration needed`,
        );
    }
    normalized.push({ path, kind: entry.kind });
  }

  const existing = records.find((c) => c.service === service);
  if (existing && existing.origin !== DEVICE_FLOW_ORIGIN)
    throw new KeychainError(409, `a credential for ${service} already exists and was not created by a login capture`);
  for (const other of records) {
    if (other.service === service) continue;
    const otherRoots = recordCaptureRoots(other).map((r) => r.path);
    for (const entry of normalized) {
      const clash = otherRoots.find((root) => pathUnder(entry.path, root) || pathUnder(root, entry.path));
      if (clash)
        throw new KeychainError(
          409,
          `path ${JSON.stringify(entry.path)} overlaps ${JSON.stringify(clash)}, already captured for ${other.service}`,
        );
    }
  }

  const check = await input.sandbox.run(
    input.handle,
    `cd "$HOME" 2>/dev/null || exit 3; hp=$(pwd -P); miss=1; for p in ${normalized.map((r) => shq(r.path)).join(" ")}; do ` +
      `rp=$(cd "$(dirname -- "$p")" 2>/dev/null && pwd -P) || continue; ` +
      `case "$rp/" in "$hp"/*|"$hp"/) ;; *) exit 4;; esac; ` +
      `[ -e "$p" ] && miss=0; done; exit $miss`,
    { timeoutMs: 30_000 },
  );
  if (check.code === 4) throw new KeychainError(400, "a registered path escapes $HOME via a symlink");
  if (check.code !== 0) throw new KeychainError(404, `nothing to capture at the registered paths for ${service}`);

  const anomalies: string[] = [];
  const saved = await captureDeviceFlowLogins({
    sandbox: input.sandbox,
    handle: input.handle,
    keychain: input.keychain,
    ownerId: input.ownerId,
    services: [service],
    credentialPaths: normalized,
    groupAs: { service, paths: normalized },
    onAnomaly: (svc, detail) => {
      anomalies.push(`${svc}: ${detail}`);
      input.onAnomaly?.(svc, detail);
    },
  });
  const recorded = await input.keychain.setCapturePaths(input.ownerId, service, normalized, DEVICE_FLOW_ORIGIN);
  if (!recorded)
    throw new KeychainError(
      404,
      `nothing was captured at the registered paths for ${service}${anomalies.length ? ` (${anomalies.join("; ")})` : " — is the login complete?"}`,
    );
  return { service, captured: saved.includes(service) };
}

export async function materializeDeviceFlowLogins(input: DeviceFlowPersistInput): Promise<string[]> {
  const bundles = (await input.keychain.materializeOwnFiles(input.ownerId)).filter(
    (b) => b.origin === DEVICE_FLOW_ORIGIN && serviceSelected(input, b.service),
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

  const toRestore = bundles
    .map((bundle) => ({
      service: bundle.service,
      files: bundle.files.filter((f) => {
        if (present.has(f.path)) return false;
        if (f.path.includes("\n")) {
          input.onAnomaly?.(bundle.service, `stored path with a newline cannot be restored: ${JSON.stringify(f.path)}`);
          return false;
        }
        return true;
      }),
    }))
    .filter((bundle) => bundle.files.length);
  if (!toRestore.length) return [];

  const tarBuf = await makeTar(
    toRestore.flatMap((bundle) =>
      bundle.files.map((f) => ({
        path: f.path,
        data: Buffer.from(f.contentBase64, "base64"),
        mode: restoredFileMode(f.mode),
      })),
    ),
  );
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const blobRel = `${CRED_WORK_DIR}/.cred-restore-${token}.tar`;
  const scriptRel = `${CRED_WORK_DIR}/.cred-restore-${token}.sh`;
  const homeHandle = rootedAt(input.handle, home);
  try {
    await input.sandbox.writeFileBytes(homeHandle, blobRel, tarBuf);

    const bundleBlocks = toRestore.map(({ service, files }) =>
      [
        `mvd=$(mktemp "$stage/.moved.XXXXXX") || mvd=""`,
        `ok=1`,
        `moved=""`,
        `if [ -z "$mvd" ]; then printf 'FAIL\\t%s\\n' ${shq(service)}; ok=""; else ` +
          `for p in ${files.map((f) => shq(f.path)).join(" ")}; do ` +
          `[ -e "$p" ] && continue; [ -f "$stage/$p" ] || continue; ` +
          `if mkdir -p "$(dirname -- "$p")" && mv "$stage/$p" "$p"; then printf '%s\\n' "$p" >> "$mvd"; moved=1; ` +
          `else while IFS= read -r q; do rm -f "$q"; done < "$mvd"; printf 'FAIL\\t%s\\n' ${shq(service)}; ok=""; break; fi; done; ` +
          `rm -f "$mvd"; fi`,
        `[ -n "$ok" ] && [ -n "$moved" ] && printf 'OK\\t%s\\n' ${shq(service)}`,
      ].join("; "),
    );
    const restoreCmd = [
      `cd "$HOME" 2>/dev/null || exit 9`,
      `${ensureCredWorkDir} || exit 9`,
      `${credTransientReaper(`.cred-restore-${token}*`)}`,
      `stage=$(mktemp -d "$HOME/${CRED_WORK_DIR}/.cred-stage.XXXXXX") || exit 9`,
      `trap 'rm -rf "$stage"' EXIT`,
      `tar -xpf ${shq(blobRel)} -C "$stage" 2>/dev/null || { rm -rf "$stage" ${shq(blobRel)}; exit 9; }`,
      ...bundleBlocks,
      `rm -rf "$stage" ${shq(blobRel)}`,
      `:`,
    ].join("\n");
    await input.sandbox.writeFileBytes(homeHandle, scriptRel, Buffer.from(restoreCmd, "utf8"));
    const run = await input.sandbox.run(
      input.handle,
      `sh "$HOME/${scriptRel}"; rc=$?; rm -f "$HOME/${scriptRel}"; exit $rc`,
      { timeoutMs: 120_000 },
    );
    if (run.code !== 0) throw new Error(`device-flow credential restore failed: ${run.stderr || `exit ${run.code}`}`);
    const restored: string[] = [];
    for (const line of run.stdout.split("\n")) {
      const [tag, service] = line.split("\t");
      if (tag === "OK" && service) restored.push(service);
      else if (tag === "FAIL" && service)
        input.onAnomaly?.(service, "restore failed mid-bundle — that bundle's files were rolled back");
    }
    return restored;
  } catch (err) {
    await input.sandbox
      .run(input.handle, `cd "$HOME" 2>/dev/null || exit 0; rm -rf ${shq(blobRel)} ${shq(scriptRel)}; :`, {
        timeoutMs: 30_000,
      })
      .catch(() => {});
    throw err;
  }
}

export async function removeDeviceFlowLogins(
  input: Pick<DeviceFlowPersistInput, "sandbox" | "handle" | "keychain" | "ownerId" | "services"> & {
    allOrigins?: boolean;
    canonicalRoots?: readonly string[];
  },
): Promise<string[]> {
  if (!input.services?.length) return [];
  const services = new Set(expandServiceAliases(input.services));
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
