import { randomBytes } from "node:crypto";
import { shq } from "../util/shell.ts";
import { swallowAs } from "../util/errors.ts";
import { makeTar, parseTar } from "./tar.ts";
import { DISPLACED_DIR_REL } from "../credentials/resident-paths.ts";
import { proxyExportPrefix } from "./sandbox-env.ts";
import { BLOB_TRANSFER_AUD, mintCapabilityToken } from "../auth/capability-token.ts";
import { CAPABILITY_HEADER } from "../api/contract.ts";

import type { BlobTransferStore } from "../persistence/blob-transfer.ts";
import type {
  AgentComputerExportArea,
  AgentComputerExportEntry,
  AgentComputerExportOptions,
  Sandbox,
  SandboxHandle,
  StageOptions,
} from "./sandbox.ts";

const posixDirname = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf("/"))) || "/";

const BLOB_TRANSFER_TTL_MS = 2 * 60_000;

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
  importFiles(
    handle: SandboxHandle,
    entries: Iterable<{ path: string; data: Uint8Array; mode?: number }>,
  ): Promise<void>;
  listDir(handle: SandboxHandle, relDir: string): Promise<string[]>;
  removeDir(handle: SandboxHandle, relDir: string): Promise<void>;
}

export function createExecFileOps({ label, exec, writeInline }: ExecFileOpsDeps): ExecFileOps {
  return {
    async importFiles(handle, entries): Promise<void> {
      const list = [...entries];
      if (!list.length) return;
      const tar = await makeTar(
        list.map((e) => ({ path: e.path, data: e.data, ...(e.mode !== undefined ? { mode: e.mode } : {}) })),
      );
      const tmp = ".extract.tar";
      await writeInline(handle.id, posixJoin(handle.rootDir, tmp), tar, tmp);
      const r = await exec(
        handle.id,
        `cd ${shq(handle.rootDir)} && tar -xf ${shq(tmp)}; rc=$?; rm -f ${shq(tmp)}; exit $rc`,
        120,
      );
      if (r.code !== 0) throw new Error(`${label} importFiles failed: ${r.stderr}`);
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

function normalizeExportRelPath(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = p.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`invalid export path: ${path}`);
  }
  return parts.join("/");
}

export function defaultExcludeAgentComputerExport(
  entry: Pick<AgentComputerExportEntry, "area" | "path">,
  credentialPrefixes: readonly string[],
): boolean {
  const rel = normalizeExportRelPath(entry.path);
  const parts = rel.split("/");
  if (entry.area === "home" && credentialPrefixes.some((pfx) => rel === pfx || rel.startsWith(`${pfx}/`))) return true;

  if (entry.area === "home" && (parts[0] === DISPLACED_DIR_REL || parts[0]?.startsWith(`${DISPLACED_DIR_REL}.`)))
    return true;
  if (entry.area === "home" && (parts[0] === ".cred-state" || parts[0]?.startsWith(".cred-state."))) return true;
  return (
    parts.includes(".aws") ||
    parts.includes("__pycache__") ||
    parts.includes(".cache") ||
    (entry.area === "home" && parts[0] === "venv")
  );
}

async function parseTarExport(
  area: AgentComputerExportArea,
  raw: Uint8Array,
  exclude: (entry: Pick<AgentComputerExportEntry, "area" | "path">) => boolean,
): Promise<AgentComputerExportEntry[]> {
  const entries: AgentComputerExportEntry[] = [];
  for (const file of await parseTar(raw)) {
    const path = normalizeExportRelPath(file.path.replace(/^\.\//, ""));
    if (!exclude({ area, path }))
      entries.push({ area, path, data: file.data, ...(file.mode !== undefined ? { mode: file.mode } : {}) });
  }
  return entries;
}

export interface ExecExportDeps {
  label: string;
  exec: ExecFileOpsDeps["exec"];
  readAbsBytes(id: string, absPath: string): Promise<Uint8Array | null>;
  defaultHomeDir: string;
  ephemeralCredentialPrefixes: readonly string[];
}

export interface ExecExport {
  exportFiles(handle: SandboxHandle, opts?: AgentComputerExportOptions): Promise<AgentComputerExportEntry[]>;
}

export function createExecExport({
  label,
  exec,
  readAbsBytes,
  defaultHomeDir,
  ephemeralCredentialPrefixes,
}: ExecExportDeps): ExecExport {
  const rootForArea = (handle: SandboxHandle, area: AgentComputerExportArea): string =>
    area === "workspace" ? handle.rootDir : (handle.homeDir ?? defaultHomeDir);

  return {
    async exportFiles(handle, exportOpts = {}): Promise<AgentComputerExportEntry[]> {
      const include = exportOpts.include ?? ["workspace", "home"];
      const exclude =
        exportOpts.exclude ?? ((entry) => defaultExcludeAgentComputerExport(entry, ephemeralCredentialPrefixes));
      const entries: AgentComputerExportEntry[] = [];
      for (const area of include) {
        const root = rootForArea(handle, area);
        const homeOnlyPrunes =
          area === "home"
            ? [
                "-path './venv'",
                "-path './venv/*'",
                `-path './${WORKSPACE_BASENAME}'`,
                `-path './${WORKSPACE_BASENAME}/*'`,

                `-path './${DISPLACED_DIR_REL}'`,
                `-path './${DISPLACED_DIR_REL}/*'`,
                `-path './${DISPLACED_DIR_REL}.*'`,
              ]
            : [];
        const contentCachePrunes = exportOpts.keepContentCaches
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
        const made = await exec(handle.id, `mktemp /tmp/agent-computer-export.XXXXXX`, 60);
        if (made.code !== 0) throw new Error(`${label} export ${area} mktemp failed: ${made.stderr}`);
        const tmp = made.stdout.trim();
        try {
          const flag = exportOpts.followSymlinks ? "-L " : "";
          const deref = exportOpts.followSymlinks ? "-h " : "";
          const paths = exportOpts.includePaths?.map((p) => shq(p)).join(" ");
          const start = paths ?? ".";
          const prunes = [...contentCachePrunes, ...homeOnlyPrunes];
          const pruneClause = prunes.length ? `\\( ${prunes.join(" -o ")} \\) -prune -o ` : "";
          const script =
            `cd ${shq(root)} 2>/dev/null || exit 0; ` +
            `find ${flag}${start} ${pruneClause}-type f -print0 ` +
            `| tar ${deref}--null -T - -cf ${shq(tmp)} 2>/dev/null`;
          const archived = await exec(handle.id, script, 120);
          if (archived.code !== 0) throw new Error(`${label} export ${area} archive failed: ${archived.stderr}`);
          const raw = await readAbsBytes(handle.id, tmp);
          if (raw === null) throw new Error(`${label} export ${area} read-back failed`);
          if (raw.length) entries.push(...(await parseTarExport(area, raw, exclude)));
        } finally {
          await exec(handle.id, `rm -f ${shq(tmp)}`, 60).catch(swallowAs(`${label}: export temp cleanup`, undefined));
        }
      }
      return entries;
    },
  };
}

interface ExecBlobStagingDeps {
  label: string;
  exec(id: string, script: string, timeoutSec: number): Promise<{ code: number; stdout: string; stderr: string }>;
  proxyPrefix(handle: SandboxHandle): string;
  apiBaseUrl: string;
  capabilityHeader: string;
  mintToken(grant: { dir: "read" | "write"; id?: string }, forTimeoutSec?: number): Promise<string>;
  timeoutSec?: number;
}

interface ExecBlobStaging {
  stageInAbs(handle: SandboxHandle, abs: string, blobId: string, timeoutSec?: number): Promise<void>;
  stageOutAbs(handle: SandboxHandle, abs: string, timeoutSec?: number): Promise<string>;
}

export interface BlobStagingOptions {
  blobTransfer?: BlobTransferStore;
  signingSecret?: string;
  capabilitySecret?: string;
  apiBaseUrl?: string;
}

const STAGE_TIMEOUT_SEC = 900;

export function createBackendBlobStaging(
  label: string,
  exec: ExecBlobStagingDeps["exec"],
  opts: BlobStagingOptions,
): Required<Pick<Sandbox, "stageIn" | "stageOut">> | null {
  const secret = opts.capabilitySecret ?? opts.signingSecret;
  if (!opts.blobTransfer || !secret || !opts.apiBaseUrl) return null;
  const staging = createExecBlobStaging({
    label,
    exec,
    proxyPrefix: proxyExportPrefix,
    apiBaseUrl: opts.apiBaseUrl,
    capabilityHeader: CAPABILITY_HEADER,
    timeoutSec: STAGE_TIMEOUT_SEC,
    mintToken: (grant, forTimeoutSec) =>
      mintCapabilityToken(
        {
          actorId: `${label}-sandbox`,
          aud: BLOB_TRANSFER_AUD,
          scopeId: `personal:${label}-sandbox`,
          blob: grant,
          exp: Date.now() + (forTimeoutSec ?? STAGE_TIMEOUT_SEC) * 1000 + BLOB_TRANSFER_TTL_MS,
        },
        secret,
      ),
  });
  return {
    async stageIn(handle: SandboxHandle, destRelPath: string, blobId: string, opts2?: StageOptions): Promise<void> {
      await staging.stageInAbs(handle, posixJoin(handle.rootDir, destRelPath), blobId, opts2?.timeoutSec);
    },
    async stageOut(handle: SandboxHandle, srcRelPath: string, opts2?: StageOptions): Promise<string> {
      return staging.stageOutAbs(handle, posixJoin(handle.rootDir, srcRelPath), opts2?.timeoutSec);
    },
  };
}

function createExecBlobStaging(deps: ExecBlobStagingDeps): ExecBlobStaging {
  const { label, exec, proxyPrefix, capabilityHeader, mintToken } = deps;
  const base = deps.apiBaseUrl.replace(/\/+$/, "");
  const timeoutSec = deps.timeoutSec ?? 300;
  return {
    async stageInAbs(handle, abs, blobId, callTimeoutSec): Promise<void> {
      const effectiveTimeoutSec = callTimeoutSec ?? timeoutSec;
      const token = await mintToken({ dir: "read", id: blobId }, effectiveTimeoutSec);
      const tmp = `${abs}.${randomBytes(8).toString("hex")}.part`;
      const script =
        proxyPrefix(handle) +
        `mkdir -p ${shq(posixDirname(abs))} && ` +
        `curl -fsS --connect-timeout 15 -H ${shq(`${capabilityHeader}: ${token}`)} ${shq(`${base}/v1/blobs/${blobId}`)} -o ${shq(tmp)} && ` +
        `mv -f ${shq(tmp)} ${shq(abs)}`;
      const r = await exec(handle.id, script, effectiveTimeoutSec);
      if (r.code !== 0) {
        await exec(handle.id, `rm -f ${shq(tmp)}`, 30).catch(swallowAs(`${label} stageIn: temp cleanup`, undefined));
        throw new Error(`${label} stageIn ${abs} failed: ${r.stderr || `curl exit ${r.code}`}`);
      }
    },

    async stageOutAbs(handle, abs, callTimeoutSec): Promise<string> {
      const effectiveTimeoutSec = callTimeoutSec ?? timeoutSec;
      const token = await mintToken({ dir: "write" }, effectiveTimeoutSec);
      const script =
        proxyPrefix(handle) +
        `sha=$(sha256sum ${shq(abs)} | cut -d' ' -f1) && ` +
        `curl -fsS --connect-timeout 15 -X POST ${shq(`${base}/v1/blobs`)} ` +
        `-H ${shq(`${capabilityHeader}: ${token}`)} ` +
        `-H "x-content-sha256: $sha" ` +
        `-H "content-type: application/octet-stream" ` +
        `--upload-file ${shq(abs)}`;
      const r = await exec(handle.id, script, effectiveTimeoutSec);
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
