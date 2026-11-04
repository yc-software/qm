import { hashId } from "../util/crypto.ts";
import { shq } from "../util/shell.ts";
import { posixJoin } from "../sandbox/exec-file-ops.ts";
import { execFailureDetail, type Sandbox, type SandboxHandle } from "../sandbox/sandbox.ts";
import { preferredBackend, SandboxAccessError, type SandboxResources } from "../sandbox/sandbox-resources.ts";
import type { ChildIsolation, ChildIsolationMode, ScopeId, Session } from "../types.ts";

const WORKDIR_ROOT = "subagents";
const WORKDIR_TIMEOUT_SEC = 60;

type OwnWorkdir = ChildIsolation & { workdir: string; branch: string };

function slug(title: string): string {
  const words = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return words.slice(0, 40).replace(/^-+|-+$/g, "") || "subagent";
}

export function childIsolation(input: {
  requested?: ChildIsolationMode;
  parent?: ChildIsolation;
  childId: string;
  title: string;
  readOnly?: boolean;
}): ChildIsolation | undefined {
  if (input.readOnly) return undefined;
  const parent = input.parent;
  const mode = input.requested ?? (parent?.workdir ? "worktree" : "shared");
  if (mode === "sandbox") return { mode, sandboxId: input.childId };
  const onSandbox = parent?.sandboxId ? { sandboxId: parent.sandboxId } : {};
  if (mode === "shared")
    return parent?.sandboxId || parent?.workdir
      ? { mode, ...onSandbox, ...(parent.workdir ? { workdir: parent.workdir } : {}) }
      : undefined;
  const name = `${slug(input.title)}-${hashId([input.childId], 8)}`;
  return {
    mode,
    ...onSandbox,
    workdir: `${WORKDIR_ROOT}/${name}`,
    branch: `subagent/${name}`,
    ...(parent?.workdir ? { base: parent.workdir } : {}),
  };
}

export function ownWorkdir(isolation: ChildIsolation | undefined): isolation is OwnWorkdir {
  return isolation?.mode === "worktree" && !!isolation.workdir && !!isolation.branch;
}

export function workdirScript(rootDir: string, isolation: OwnWorkdir): string {
  const dir = shq(posixJoin(rootDir, isolation.workdir));
  const git = `git -C ${shq(isolation.base ? posixJoin(rootDir, isolation.base) : rootDir)}`;
  const branch = shq(isolation.branch);
  return [
    `[ -d ${dir} ] && exit 0`,
    `mkdir -p ${shq(posixJoin(rootDir, WORKDIR_ROOT))} || exit 1`,
    `if ! ${git} rev-parse --is-inside-work-tree >/dev/null 2>&1; then exec mkdir ${dir}; fi`,
    `${git} worktree prune || exit 1`,
    `if ${git} show-ref --verify --quiet ${shq(`refs/heads/${isolation.branch}`)}; then exec ${git} worktree add -q ${dir} ${branch}; fi`,
    `exec ${git} worktree add -q -b ${branch} ${dir}`,
  ].join("\n");
}

export async function ensureChildSandbox(
  resources: SandboxResources | undefined,
  input: { id: string; session: Session; actorId: string; scopeId: ScopeId; backendScopeId: ScopeId },
): Promise<void> {
  if (!resources) throw new Error("sandbox inventory unavailable");
  const record = await resources.get(input.id).catch((error: unknown) => {
    if (error instanceof SandboxAccessError) return null;
    throw error;
  });
  if (record && record.ownerScopeId !== input.scopeId)
    throw new Error(`sandbox ${input.id} belongs to another scope, not this subagent`);
  if (record?.state === "ready") return;
  if (record?.state === "retired") throw new Error(`this subagent's sandbox ${input.id} has been retired`);
  const name = input.id === input.session.id && input.session.title ? input.session.title : `subagent ${input.id}`;
  const backend = await preferredBackend(resources, input.backendScopeId);
  await resources.create(input.actorId, input.scopeId, backend, name, input.id);
}

export async function prepareChildWorkdir(
  sandbox: Sandbox,
  handle: SandboxHandle,
  isolation: ChildIsolation | undefined,
): Promise<void> {
  if (!ownWorkdir(isolation)) return;
  const result = await sandbox.run(handle, workdirScript(handle.rootDir, isolation), {
    timeoutMs: WORKDIR_TIMEOUT_SEC * 1000,
  });
  if (result.code !== 0)
    throw new Error(
      `could not prepare this subagent's directory ${isolation.workdir}: ${execFailureDetail(result, WORKDIR_TIMEOUT_SEC)}`,
    );
}

const baseName = (isolation: ChildIsolation): string => isolation.base ?? "the workspace root";

export function isolationBrief(isolation: ChildIsolation | undefined): string | undefined {
  if (!isolation) return undefined;
  if (isolation.mode === "sandbox")
    return `Commands that omit sandbox_id run on your own sandbox, ${isolation.sandboxId}, created the first time you use it. Your parent's files are not on it; fetch what you need from git or Files.`;
  const machine = isolation.sandboxId ? ` on sandbox ${isolation.sandboxId}` : "";
  if (ownWorkdir(isolation))
    return `Commands that omit sandbox_id start in your own directory, ${isolation.workdir} in the workspace${machine}: a git worktree on the new branch ${isolation.branch} if ${baseName(isolation)} is a git repository, otherwise an empty directory.`;
  const shared = [
    ...(isolation.sandboxId ? [`run on sandbox ${isolation.sandboxId}`] : []),
    ...(isolation.workdir ? [`start in ${isolation.workdir} in the workspace`] : []),
  ];
  return `Commands that omit sandbox_id ${shared.join(" and ")}, as your parent's do.`;
}

export function isolationLabel(isolation: ChildIsolation | undefined): string | undefined {
  if (!isolation) return undefined;
  if (isolation.mode === "sandbox") return `own sandbox ${isolation.sandboxId}, created on first use`;
  const machine = isolation.sandboxId ? ` on sandbox ${isolation.sandboxId}` : "";
  if (ownWorkdir(isolation))
    return `own directory ${isolation.workdir}${machine}; git branch ${isolation.branch} if ${baseName(isolation)} is a repository`;
  if (!isolation.workdir) return `shares its parent's sandbox ${isolation.sandboxId}`;
  return `shares its parent's directory ${isolation.workdir}${machine}`;
}
