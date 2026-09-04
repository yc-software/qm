import { randomBytes } from "node:crypto";
import { shq } from "../util/shell.ts";
import { swallowAs } from "../util/errors.ts";
import { makeTar, parseTar } from "./tar.ts";

import type {
  AgentComputerBackupArea,
  AgentComputerBackupEntry,
  AgentComputerBackupOptions,
  SandboxHandle,
} from "./sandbox.ts";

const posixDirname = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf("/"))) || "/";

export const BLOB_TRANSFER_TTL_MS = 2 * 60_000;

export function posixJoin(base: string, rel: string): string {
  const clean = rel.replace(/^\/+/, "");
  return clean ? `${base.replace(/\/+$/, "")}/${clean}` : base;
}

export interface ExecFileOpsDeps {
  label: string;
  exec(id: string, script: string, timeoutSec: number): Promise<{ code: number; stdout: string; stderr: string }>;
  writeInline(id: string, abs: string, data: Uint8Array, label: string): Promise<void>;
}

export interface ExecFileOps {
  extractFiles(handle: SandboxHandle, entries: Iterable<{ path: string; data: Uint8Array }>): Promise<void>;
  listDir(handle: SandboxHandle, relDir: string): Promise<string[]>;
  removeDir(handle: SandboxHandle, relDir: string): Promise<void>;
}

export function createExecFileOps({ label, exec, writeInline }: ExecFileOpsDeps): ExecFileOps {
  return {
    async extractFiles(handle, entries): Promise<void> {
      const list = [...entries];
      if (!list.length) return;
      const tar = await makeTar(list.map((e) => ({ path: e.path, data: e.data })));
      const tmp = ".extract.tar";
      await writeInline(handle.id, posixJoin(handle.rootDir, tmp), tar, tmp);
      const r = await exec(
        handle.id,
        `cd ${shq(handle.rootDir)} && tar -xf ${shq(tmp)}; rc=$?; rm -f ${shq(tmp)}; exit $rc`,
        120,
      );
      if (r.code !== 0) throw new Error(`${label} extractFiles failed: ${r.stderr}`);
    },

    async listDir(handle, relDir): Promise<string[]> {
      const rel = relDir.replace(/^\/+/, "") || ".";
      const r = await exec(
        handle.id,
        `cd ${shq(handle.rootDir)} 2>/dev/null && find ${shq(rel)} -type f 2>/dev/null`,
        60,
      );
      if (r.code !== 0) return [];
      return r.stdout
        .split("\n")
        .map((s) => s.trim().replace(/^\.\//, ""))
        .filter(Boolean);
    },

    async removeDir(handle, relDir): Promise<void> {
      const rel = relDir.replace(/^\/+/, "");
      if (!rel) return;
      const abs = posixJoin(handle.rootDir, rel);
      if (abs === handle.rootDir) return;
      const r = await exec(handle.id, `rm -rf ${shq(abs)}`, 60);
      if (r.code !== 0) throw new Error(`${label} removeDir ${relDir} failed: ${r.stderr}`);
    },
  };
}

const WORKSPACE_BASENAME = "workspace";

function normalizeBackupRelPath(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = p.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`invalid backup path: ${path}`);
  }
  return parts.join("/");
}

function defaultExcludeAgentComputerBackup(
  entry: Pick<AgentComputerBackupEntry, "area" | "path">,
  credentialPrefixes: readonly string[],
): boolean {
  const rel = normalizeBackupRelPath(entry.path);
  const parts = rel.split("/");
  if (entry.area === "home" && credentialPrefixes.some((pfx) => rel === pfx || rel.startsWith(`${pfx}/`))) return true;
  return (
    parts.includes(".aws") ||
    parts.includes("__pycache__") ||
    parts.includes(".cache") ||
    (entry.area === "home" && parts[0] === "venv")
  );
}

async function parseTarBackup(
  area: AgentComputerBackupArea,
  raw: Uint8Array,
  exclude: (entry: Pick<AgentComputerBackupEntry, "area" | "path">) => boolean,
): Promise<AgentComputerBackupEntry[]> {
  const entries: AgentComputerBackupEntry[] = [];
  for (const file of await parseTar(raw)) {
    const path = normalizeBackupRelPath(file.path.replace(/^\.\//, ""));
    if (!exclude({ area, path })) entries.push({ area, path, data: file.data });
  }
  return entries;
}

export interface ExecBackupDeps {
  label: string;
  exec: ExecFileOpsDeps["exec"];
  readAbsBytes(id: string, absPath: string): Promise<Uint8Array | null>;
  defaultHomeDir: string;
  ephemeralCredentialPrefixes: readonly string[];
}

export interface ExecBackup {
  backupComputer(handle: SandboxHandle, opts?: AgentComputerBackupOptions): Promise<AgentComputerBackupEntry[]>;
}

export function createExecBackup({
  label,
  exec,
  readAbsBytes,
  defaultHomeDir,
  ephemeralCredentialPrefixes,
}: ExecBackupDeps): ExecBackup {
  const rootForArea = (handle: SandboxHandle, area: AgentComputerBackupArea): string =>
    area === "workspace" ? handle.rootDir : (handle.homeDir ?? defaultHomeDir);

  return {
    async backupComputer(handle, backupOpts = {}): Promise<AgentComputerBackupEntry[]> {
      const include = backupOpts.include ?? ["workspace", "home"];
      const exclude =
        backupOpts.exclude ?? ((entry) => defaultExcludeAgentComputerBackup(entry, ephemeralCredentialPrefixes));
      const entries: AgentComputerBackupEntry[] = [];
      for (const area of include) {
        const root = rootForArea(handle, area);
        const homeOnlyPrunes =
          area === "home"
            ? [
                "-path './venv'",
                "-path './venv/*'",
                `-path './${WORKSPACE_BASENAME}'`,
                `-path './${WORKSPACE_BASENAME}/*'`,
              ]
            : [];
        const contentCachePrunes = backupOpts.keepContentCaches
          ? []
          : [
              "-path './__pycache__'",
              "-path './__pycache__/*'",
              "-path '*/__pycache__'",
              "-path '*/__pycache__/*'",
              "-path './.cache'",
              "-path './.cache/*'",
              "-path '*/.cache'",
              "-path '*/.cache/*'",
            ];
        const made = await exec(handle.id, `mktemp /tmp/agent-computer-backup.XXXXXX`, 60);
        if (made.code !== 0) throw new Error(`${label} backup ${area} mktemp failed: ${made.stderr}`);
        const tmp = made.stdout.trim();
        try {
          const flag = backupOpts.followSymlinks ? "-L " : "";
          const deref = backupOpts.followSymlinks ? "-h " : "";
          const paths = backupOpts.includePaths?.map((p) => shq(p)).join(" ");
          const start = paths ?? ".";
          const prunes = [...contentCachePrunes, ...homeOnlyPrunes];
          const pruneClause = prunes.length ? `\\( ${prunes.join(" -o ")} \\) -prune -o ` : "";
          const script =
            `cd ${shq(root)} 2>/dev/null || exit 0; ` +
            `find ${flag}${start} ${pruneClause}-type f -print0 ` +
            `| tar ${deref}--null -T - -cf ${shq(tmp)} 2>/dev/null`;
          const archived = await exec(handle.id, script, 120);
          if (archived.code !== 0) throw new Error(`${label} backup ${area} archive failed: ${archived.stderr}`);
          const raw = await readAbsBytes(handle.id, tmp);
          if (raw === null) throw new Error(`${label} backup ${area} read-back failed`);
          if (raw.length) entries.push(...(await parseTarBackup(area, raw, exclude)));
        } finally {
          await exec(handle.id, `rm -f ${shq(tmp)}`, 60).catch(swallowAs(`${label}: backup temp cleanup`, undefined));
        }
      }
      return entries;
    },
  };
}

export interface ExecBlobStagingDeps {
  label: string;
  exec(id: string, script: string, timeoutSec: number): Promise<{ code: number; stdout: string; stderr: string }>;
  proxyPrefix(handle: SandboxHandle): string;
  apiBaseUrl: string;
  capabilityHeader: string;
  mintToken(grant: { dir: "read" | "write"; id?: string }): Promise<string>;
  timeoutSec?: number;
}

export interface ExecBlobStaging {
  stageInAbs(handle: SandboxHandle, abs: string, blobId: string): Promise<void>;
  stageOutAbs(handle: SandboxHandle, abs: string): Promise<string>;
}

export function createExecBlobStaging(deps: ExecBlobStagingDeps): ExecBlobStaging {
  const { label, exec, proxyPrefix, capabilityHeader, mintToken } = deps;
  const base = deps.apiBaseUrl.replace(/\/+$/, "");
  const timeoutSec = deps.timeoutSec ?? 300;
  return {
    async stageInAbs(handle, abs, blobId): Promise<void> {
      const token = await mintToken({ dir: "read", id: blobId });
      const tmp = `${abs}.${randomBytes(8).toString("hex")}.part`;
      const script =
        proxyPrefix(handle) +
        `mkdir -p ${shq(posixDirname(abs))} && ` +
        `curl -fsS --connect-timeout 15 -H ${shq(`${capabilityHeader}: ${token}`)} ${shq(`${base}/v1/blobs/${blobId}`)} -o ${shq(tmp)} && ` +
        `mv -f ${shq(tmp)} ${shq(abs)}`;
      const r = await exec(handle.id, script, timeoutSec);
      if (r.code !== 0) {
        await exec(handle.id, `rm -f ${shq(tmp)}`, 30).catch(swallowAs(`${label} stageIn: temp cleanup`, undefined));
        throw new Error(`${label} stageIn ${abs} failed: ${r.stderr || `curl exit ${r.code}`}`);
      }
    },

    async stageOutAbs(handle, abs): Promise<string> {
      const token = await mintToken({ dir: "write" });
      const script =
        proxyPrefix(handle) +
        `sha=$(sha256sum ${shq(abs)} | cut -d' ' -f1) && ` +
        `curl -fsS --connect-timeout 15 -X POST ${shq(`${base}/v1/blobs`)} ` +
        `-H ${shq(`${capabilityHeader}: ${token}`)} ` +
        `-H "x-content-sha256: $sha" ` +
        `-H "content-type: application/octet-stream" ` +
        `--upload-file ${shq(abs)}`;
      const r = await exec(handle.id, script, timeoutSec);
      if (r.code !== 0) throw new Error(`${label} stageOut ${abs} failed: ${r.stderr || `curl exit ${r.code}`}`);
      let blobId: string | undefined;
      try {
        blobId = (JSON.parse(r.stdout) as { blobId?: string }).blobId;
      } catch {
        throw new Error(`${label} stageOut ${abs}: unparseable response: ${r.stdout.slice(0, 200)}`);
      }
      if (!blobId) throw new Error(`${label} stageOut ${abs}: no blobId in response: ${r.stdout.slice(0, 200)}`);
      return blobId;
    },
  };
}
