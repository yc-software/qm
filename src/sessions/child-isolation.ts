import { posix } from "node:path";
import { hashId } from "../util/crypto.ts";
import { shq } from "../util/shell.ts";
import { posixJoin } from "../sandbox/exec-file-ops.ts";
import { execFailureDetail, type Sandbox, type SandboxHandle } from "../sandbox/sandbox.ts";
import { preferredBackend, SandboxAccessError, type SandboxResources } from "../sandbox/sandbox-resources.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { ChildIsolation, ChildIsolationMode, ChildWorkdir, ScopeId, Session } from "../types.ts";

const WORKDIR_ROOT = "subagents";
const WORKDIR_TIMEOUT_SEC = 300;

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
  if (mode === "shared") {
    if (!parent?.sandboxId && !parent?.workdir) return undefined;
    return { ...parent, mode };
  }
  const name = `${slug(input.title)}-${hashId([input.childId], 8)}`;
  const parentWorkdir = parent && ownWorkdir(parent);
  const baseChain = parentWorkdir ? [...(parent.baseChain ?? []), parentWorkdir] : [];
  return {
    mode,
    ...onSandbox,
    workdir: `${WORKDIR_ROOT}/${name}`,
    branch: `subagent/${name}`,
    ...(parent?.workdir ? { base: parent.workdir } : {}),
    ...(baseChain.length ? { baseChain } : {}),
  };
}

function ownWorkdir(isolation: ChildIsolation): ChildWorkdir | undefined {
  if (!isolation.workdir || !isolation.branch) return undefined;
  return { workdir: isolation.workdir, branch: isolation.branch, ...(isolation.base ? { base: isolation.base } : {}) };
}

function readyMarker(rootDir: string, step: ChildWorkdir): string {
  return shq(posixJoin(rootDir, posix.join(posix.dirname(step.workdir), `.${posix.basename(step.workdir)}.ready`)));
}

function isReady(rootDir: string, step: ChildWorkdir): string {
  return `[ -f ${readyMarker(rootDir, step)} ] && [ -d ${shq(posixJoin(rootDir, step.workdir))} ]`;
}

function workdirStep(rootDir: string, step: ChildWorkdir): string {
  const dir = posixJoin(rootDir, step.workdir);
  const ready = readyMarker(rootDir, step);
  const base = posixJoin(rootDir, step.base ?? "");
  const git = `git -C ${shq(base)}`;
  const branch = shq(step.branch);
  const isWorktree = `[ -d ${shq(dir)} ] && [ "$(git -C ${shq(dir)} rev-parse --show-toplevel 2>/dev/null)" = "$(cd ${shq(dir)} && pwd -P)" ]`;
  return [
    `${isReady(rootDir, step)} && exit 0`,
    `mkdir -p ${shq(posixJoin(rootDir, WORKDIR_ROOT))} || exit 1`,
    `[ -d ${shq(base)} ] || { echo "base directory ${step.base ?? "."} does not exist yet" >&2; exit 1; }`,
    `if ${git} rev-parse --is-inside-work-tree >/dev/null 2>&1; then`,
    ...(step.base
      ? []
      : [
          `  info="$(cd ${shq(base)} && cd "$(git rev-parse --git-common-dir)" && pwd)/info" && mkdir -p "$info" && { grep -qxF '/${WORKDIR_ROOT}/' "$info/exclude" 2>/dev/null || echo '/${WORKDIR_ROOT}/' >> "$info/exclude"; }`,
        ]),
    `  if ! { ${isWorktree}; }; then`,
    `    ${git} worktree remove --force ${shq(dir)} >/dev/null 2>&1; rm -rf ${shq(dir)}; ${git} worktree prune || exit 1`,
    `    if ${git} show-ref --verify --quiet ${shq(`refs/heads/${step.branch}`)}; then ${git} worktree add -q ${shq(dir)} ${branch} || exit 1`,
    `    else ${git} worktree add -q -b ${branch} ${shq(dir)} || exit 1; fi`,
    `    ${isWorktree} || { echo "${step.workdir} is not a complete git worktree" >&2; exit 1; }`,
    `  fi`,
    `else mkdir -p ${shq(dir)} || exit 1; fi`,
    `touch ${ready}`,
  ].join("\n");
}

function workdirScript(rootDir: string, isolation: ChildIsolation): string | undefined {
  const own = ownWorkdir(isolation);
  if (!own) return undefined;
  return [...(isolation.baseChain ?? []), own]
    .map((step) => `(\n${workdirStep(rootDir, step)}\n) || exit 1`)
    .join("\n");
}

export async function prepareChildWorkdir(
  sandbox: Sandbox,
  handle: SandboxHandle,
  isolation: ChildIsolation | undefined,
  lock: AdvisoryLock,
): Promise<void> {
  const own = isolation && ownWorkdir(isolation);
  const script = isolation && workdirScript(handle.rootDir, isolation);
  if (!own || !script) return;
  if ((await sandbox.run(handle, isReady(handle.rootDir, own), { timeoutMs: WORKDIR_TIMEOUT_SEC * 1000 })).code === 0)
    return;
  const result = await lock.withLock(`subagent-workdirs:${handle.resourceId ?? handle.id}`, () =>
    sandbox.run(handle, script, { timeoutMs: WORKDIR_TIMEOUT_SEC * 1000 }),
  );
  if (result.code !== 0)
    throw new Error(
      `could not prepare this subagent's directory ${isolation.workdir}: ${execFailureDetail(result, WORKDIR_TIMEOUT_SEC)}`,
    );
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
  if (record?.state === "retired")
    throw new Error(`sandbox ${input.id} has been retired; pass sandbox_id to use another computer`);
  const backend = record?.backend ?? (await preferredBackend(resources, input.backendScopeId));
  if (!resources.profiles().some((profile) => profile.name === backend && profile.actions.includes("retire")))
    throw new Error(`${backend} computers cannot be retired, so a subagent cannot have its own sandbox there`);
  const name = input.id === input.session.id && input.session.title ? input.session.title : `subagent ${input.id}`;
  await resources.create(input.actorId, input.scopeId, backend, name, input.id);
}

const DEFAULT_TOOLS = "execute, files, skills and apps use it when sandbox_id is omitted";

export function isolationBrief(isolation: ChildIsolation | undefined): string | undefined {
  if (!isolation) return undefined;
  if (isolation.mode === "sandbox")
    return `Your default computer is your own sandbox, ${isolation.sandboxId}: ${DEFAULT_TOOLS}. Your parent's files are not on it; fetch what you need from git or Files.`;
  const lines = isolation.sandboxId
    ? [`Your default computer is your parent's sandbox, ${isolation.sandboxId}: ${DEFAULT_TOOLS}.`]
    : [];
  const paths = `Paths in files, attach and apps stay relative to the workspace root, so prefix them with ${isolation.workdir}/.`;
  if (isolation.mode === "worktree")
    lines.push(
      `Commands that omit sandbox_id start in your own directory, ${isolation.workdir} in the workspace: a git worktree on the new branch ${isolation.branch} if ${isolation.base ?? "the workspace root"} is a git repository, otherwise an empty directory. ${paths}`,
    );
  else if (isolation.workdir)
    lines.push(
      `Commands that omit sandbox_id start in ${isolation.workdir} in the workspace, as your parent's do. ${paths}`,
    );
  return lines.join(" ");
}

export function isolationLabel(isolation: ChildIsolation | undefined): string | undefined {
  if (!isolation) return undefined;
  if (isolation.mode === "sandbox") return `own sandbox ${isolation.sandboxId}`;
  const machine = isolation.sandboxId ? ` on sandbox ${isolation.sandboxId}` : "";
  if (isolation.mode === "worktree")
    return `own directory ${isolation.workdir}${machine}; git branch ${isolation.branch} if ${isolation.base ?? "the workspace root"} is a repository`;
  if (!isolation.workdir) return `shares its parent's sandbox ${isolation.sandboxId}`;
  return `shares its parent's directory ${isolation.workdir}${machine}`;
}
