import { randomUUID } from "node:crypto";
import type { AdvisoryLock } from "./persistence/advisory-lock.ts";
import { createNoopAdvisoryLock } from "./persistence/advisory-lock.ts";
import type { Sandbox, SandboxHandle, ProvisionOptions } from "./sandbox/sandbox.ts";
import { detectPathCollisions, SKILL_MATERIALIZATION_LOCK, skillRecordPaths } from "./skills/skill-collision.ts";
import { parseSeedSkill } from "./skills/seed.ts";
import { safeSkillFilePath, type SkillFile, type SkillManifest, type SkillStore } from "./skills/skill-store.ts";
import { parseScopeId, type ScopeId, type WorkspaceLayer } from "./types.ts";
import { createKeyedQueue } from "./util/async.ts";
import { swallowAs } from "./util/errors.ts";
import { shq } from "./util/shell.ts";

export interface PersonalDefaultFile {
  path: string;
  content: string;
  executable?: boolean;
}

export interface PersonalDefaultsService {
  ensure(scopeId: ScopeId | undefined): Promise<void>;
}

export const PERSONAL_DEFAULT_CREATED_BY = "system:personal-default";
export const PERSONAL_DEFAULT_REVIEWER = "system:personal-default-reviewer";

const INSTALL_DEFAULT_SCRIPT = `const fs=require("node:fs"),cp=require("node:child_process"),c=fs.constants;
const [root,temp,target]=process.argv.slice(1),parts=target.split("/"),base=parts.pop();
let fd;
try {
  fd=fs.openSync(root,c.O_RDONLY|c.O_DIRECTORY|c.O_NOFOLLOW);
  for(const part of parts){
    const next="/proc/self/fd/"+fd+"/"+part;
    try{fs.mkdirSync(next)}catch(error){if(error.code!=="EEXIST")throw error}
    const nextFd=fs.openSync(next,c.O_RDONLY|c.O_DIRECTORY|c.O_NOFOLLOW);
    fs.closeSync(fd);
    fd=nextFd;
  }
  const result=cp.spawnSync("ln",["-T",root+"/"+temp,"/proc/self/fd/3/"+base],{stdio:["ignore","ignore","ignore",fd]});
  if(result.status!==0){
    try{fs.lstatSync("/proc/self/fd/"+fd+"/"+base);process.exit(0)}catch{}
    process.exit(result.status??1);
  }
} finally {
  if(fd!==undefined)try{fs.closeSync(fd)}catch{}
  try{fs.unlinkSync(root+"/"+temp)}catch{}
}`;

export function safePersonalWorkspacePath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) {
    throw new Error(`invalid personal workspace path: ${path}`);
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) {
    throw new Error(`invalid personal workspace path: ${path}`);
  }
  return parts.join("/");
}

export function assertNoPersonalWorkspaceConflicts(files: readonly PersonalDefaultFile[]): void {
  const paths = files.map((file) => safePersonalWorkspacePath(file.path)).sort();
  for (const [index, path] of paths.entries()) {
    const descendant = paths[index + 1];
    if (descendant?.startsWith(`${path}/`)) {
      throw new Error(`personal workspace defaults conflict: ${path} is an ancestor of ${descendant}`);
    }
  }
}

export function parseDefaultSkillTrees(files: readonly PersonalDefaultFile[], label: string): SkillManifest[] {
  const byDir = new Map<string, PersonalDefaultFile[]>();
  for (const file of files) {
    const path = safeSkillFilePath(file.path);
    const slash = path.indexOf("/");
    if (slash < 1) throw new Error(`${label} path must be <id>/<file>: ${path}`);
    const dir = path.slice(0, slash);
    const entries = byDir.get(dir) ?? [];
    entries.push({ ...file, path });
    byDir.set(dir, entries);
  }
  const manifests: SkillManifest[] = [];
  const names = new Set<string>();
  for (const [dir, entries] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
    const root = entries.find((file) => file.path === `${dir}/SKILL.md`);
    if (!root) throw new Error(`${label} ${dir} has no SKILL.md`);
    const manifest = parseSeedSkill(root.content);
    if (names.has(manifest.name)) throw new Error(`duplicate ${label} name: ${manifest.name}`);
    names.add(manifest.name);
    manifest.files = entries
      .filter((file) => file !== root)
      .map((file): SkillFile => ({
        path: safeSkillFilePath(file.path.slice(dir.length + 1)),
        content: file.content,
        ...(file.executable === true ? { executable: true } : {}),
      }));
    manifests.push(manifest);
  }
  const claimed = new Map<string, string>();
  for (const manifest of manifests) {
    const collisions = detectPathCollisions(skillRecordPaths(manifest.name, manifest.files), claimed);
    if (collisions.length) {
      throw new Error(
        `${label} "${manifest.name}" materializes over ${collisions[0]!.path}, already claimed by ${collisions[0]!.owner}`,
      );
    }
    for (const path of skillRecordPaths(manifest.name, manifest.files)) {
      claimed.set(path, `${label} "${manifest.name}"`);
    }
  }
  return manifests;
}

export function createPersonalDefaultsService(opts: {
  skills: SkillStore;
  manifests: () => readonly SkillManifest[];
  advisoryLock?: AdvisoryLock;
}): PersonalDefaultsService {
  const queue = createKeyedQueue<string>();
  const advisoryLock = opts.advisoryLock ?? createNoopAdvisoryLock();
  const completed = new Map<ScopeId, string>();
  return {
    async ensure(scopeId): Promise<void> {
      if (!scopeId || parseScopeId(scopeId).kind !== "personal") return;
      const manifests = opts.manifests();
      if (!manifests.length) return;
      const revision = manifests
        .map((manifest) => manifest.name)
        .sort()
        .join("\0");
      if (completed.get(scopeId) === revision) return;
      const existingBeforeLock = (await opts.skills.list()).filter((skill) => skill.scopeId === scopeId);
      const needsEnsure = existingBeforeLock.some(
        (skill) =>
          manifests.some((manifest) => manifest.name === skill.manifest.name) &&
          skill.createdBy === PERSONAL_DEFAULT_CREATED_BY &&
          skill.status !== "published" &&
          skill.status !== "archived",
      );
      const existingNames = new Set(existingBeforeLock.map((skill) => skill.manifest.name));
      if (!needsEnsure && manifests.every((manifest) => existingNames.has(manifest.name))) {
        completed.set(scopeId, revision);
        return;
      }
      await queue(scopeId, () =>
        advisoryLock.withLock(SKILL_MATERIALIZATION_LOCK, async () => {
          if (completed.get(scopeId) === revision) return;
          const existing = (await opts.skills.list()).filter((skill) => skill.scopeId === scopeId);
          for (const source of manifests) {
            const found = existing.find((skill) => skill.manifest.name === source.name);
            if (found) {
              if (
                found.createdBy === PERSONAL_DEFAULT_CREATED_BY &&
                found.status !== "published" &&
                found.status !== "archived"
              ) {
                await opts.skills.review(found.id, PERSONAL_DEFAULT_REVIEWER, found.manifest.requiredCapabilities);
                await opts.skills.publish(found.id);
              }
              continue;
            }
            const manifest = structuredClone(source);
            const skill = await opts.skills.create({
              scopeId,
              manifest,
              createdBy: PERSONAL_DEFAULT_CREATED_BY,
            });
            await opts.skills.review(skill.id, PERSONAL_DEFAULT_REVIEWER, manifest.requiredCapabilities);
            await opts.skills.publish(skill.id);
            existing.push(skill);
          }
          completed.set(scopeId, revision);
        }),
      );
    },
  };
}

export async function materializePersonalWorkspaceDefaults(
  sandbox: Sandbox,
  handle: SandboxHandle,
  files: readonly PersonalDefaultFile[],
): Promise<void> {
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const path = safePersonalWorkspacePath(file.path);
    const exists = await sandbox.run(handle, `[ -e ${shq(path)} ] || [ -L ${shq(path)} ]`);
    if (exists.code === 0) continue;
    const temp = `.personal-default-${randomUUID()}`;
    await sandbox.writeFile(handle, temp, file.content);
    if (file.executable === true) {
      const executable = await sandbox.run(handle, `chmod +x -- ${shq(temp)}`);
      if (executable.code !== 0) throw new Error(`could not mark personal workspace default executable: ${path}`);
    }
    const installed = await sandbox.run(
      handle,
      `node -e ${shq(INSTALL_DEFAULT_SCRIPT)} ${shq(handle.rootDir)} ${shq(temp)} ${shq(path)}`,
    );
    if (installed.code === 0) continue;
    throw new Error(`could not create personal workspace default: ${path}`);
  }
}

export function withPersonalWorkspaceDefaults(sandbox: Sandbox, files: () => readonly PersonalDefaultFile[]): Sandbox {
  const queue = createKeyedQueue<string>();
  return {
    ...sandbox,
    async provision(layers: WorkspaceLayer[], opts?: ProvisionOptions): Promise<SandboxHandle> {
      const defaults = files();
      const writable = layers.find((layer) => layer.mode === "rw")?.scopeId;
      if (
        !defaults.length ||
        opts?.scratch ||
        opts?.personalDefaults !== true ||
        !writable ||
        parseScopeId(writable).kind !== "personal"
      ) {
        return sandbox.provision(layers, opts);
      }
      return queue(writable, async () => {
        const handle = await sandbox.provision(layers, opts);
        try {
          await materializePersonalWorkspaceDefaults(sandbox, handle, defaults);
          return handle;
        } catch (error) {
          await sandbox
            .teardown(handle)
            .catch(swallowAs("personal defaults: teardown after failed provision", undefined));
          throw error;
        }
      });
    },
  };
}
