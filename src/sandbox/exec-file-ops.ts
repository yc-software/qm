import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { shq } from "../util/shell.ts";
import { swallowAs } from "../util/errors.ts";
import { trimTrailingSlashes } from "../util/text.ts";
import { makeTar, parseTar } from "./tar.ts";
import { DISPLACED_DIR_REL } from "../credentials/resident-paths.ts";

import {
  hasParentPathSegment,
  type AgentComputerExportArea,
  type AgentComputerExportEntry,
  type AgentComputerExportOptions,
  type SandboxHandle,
} from "./sandbox.ts";

export const tempPathBeside = (absPath: string): string =>
  posix.join(posix.dirname(absPath), `.qm-${randomBytes(8).toString("hex")}`);

function workspaceRel(rel: string): string {
  if (hasParentPathSegment(rel)) throw new Error(`${rel} must stay inside the workspace — no .. path segments`);
  return rel.replace(/^\/+/, "");
}

export function workspacePathOf(rootDir: string, absPath: string): string | null {
  const rel = posix.relative(posix.normalize(rootDir), posix.normalize(absPath));
  return rel && !rel.startsWith("..") && !posix.isAbsolute(rel) ? rel : null;
}

export function posixJoin(base: string, rel: string): string {
  const clean = workspaceRel((rel.startsWith("/") && workspacePathOf(base, rel)) || rel);
  return clean ? `${trimTrailingSlashes(base)}/${clean}` : base;
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

const listFilesScript = (rootDir: string, rel: string): string =>
  `cd ${shq(rootDir)} 2>/dev/null && [ -e ${shq(rel)} ] || exit 0; find ${shq(rel)} -type f`;

export function createExecFileOps({ label, exec, writeInline }: ExecFileOpsDeps): ExecFileOps {
  return {
    async importFiles(handle, entries): Promise<void> {
      const list = [...entries];
      if (!list.length) return;
      const tar = await makeTar(
        list.map((e) => ({ path: e.path, data: e.data, ...(e.mode !== undefined ? { mode: e.mode } : {}) })),
      );
      const tmp = `.extract-${randomBytes(16).toString("hex")}.tar`;
      await writeInline(handle.id, posixJoin(handle.rootDir, tmp), tar, tmp);
      const r = await exec(
        handle.id,
        `cd ${shq(handle.rootDir)} && tar -xf ${shq(tmp)}; rc=$?; rm -f ${shq(tmp)}; exit $rc`,
        120,
      );
      if (r.code !== 0) throw new Error(`${label} importFiles failed: ${r.stderr}`);
    },

    async listDir(handle, relDir): Promise<string[]> {
      const rel = workspaceRel(relDir) || ".";
      const r = await exec(handle.id, listFilesScript(handle.rootDir, rel), 60);
      if (r.code !== 0) throw new Error(`${label} listDir failed (exit ${r.code}): ${r.stderr.trim()}`);
      return r.stdout
        .split("\n")
        .map((s) => s.trim().replace(/^\.\//, ""))
        .filter(Boolean);
    },

    async removeDir(handle, relDir): Promise<void> {
      const rel = workspaceRel(relDir);
      if (!rel) return;
      const r = await exec(handle.id, `rm -rf ${shq(posixJoin(handle.rootDir, rel))}`, 60);
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
