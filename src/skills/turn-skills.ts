import type { Tenant } from "../tenants/context.ts";
import { hashId } from "../util/crypto.ts";
import type { ScopeId } from "../types.ts";
import type { SandboxHandle } from "../sandbox/sandbox.ts";
import type { SandboxAccessPlan } from "../sandbox/sandbox-resources.ts";
import {
  materializeSkillTree as laySkillTree,
  packRoot,
  rehomeSkillPaths,
  renderSkillBody,
  skillDir,
  SKILLS_ROOT,
} from "./materialize.ts";
import { safeSkillFilePath, type SkillResolution } from "./skill-store.ts";
import { isSafeSkillName } from "./skill-name.ts";
import type { SkillResult } from "../tools/primitives.ts";
import { errMessage, swallow, swallowAs } from "../util/errors.ts";
import { loadActiveBundles } from "../core/orchestrator/turn-helpers.ts";
import type { OrchestratorDeps } from "../core/orchestrator/types.ts";

export interface TurnSkillsContext {
  tenant: Tenant;
  deps: Pick<OrchestratorDeps, "sandbox" | "skills" | "skillBundles" | "errors">;
  scopeId: ScopeId;
  sessionId: string;
  turnSessionDir: string;
  visibleSkillsForTurn: (sources?: readonly string[]) => Promise<SkillResolution[]>;
  accessResource: (id: string) => Promise<SandboxAccessPlan>;
  provisionResource: (access: SandboxAccessPlan) => Promise<SandboxHandle>;
  provision: () => Promise<SandboxHandle>;
}

export function createTurnSkills(ctx: TurnSkillsContext) {
  const {
    tenant,
    deps,
    scopeId,
    sessionId,
    turnSessionDir,
    visibleSkillsForTurn,
    accessResource,
    provisionResource,
    provision,
  } = ctx;
  const skillsRoot = (r: SkillResolution) =>
    `${SKILLS_ROOT}/${turnSessionDir.split("/").at(-1)}/${hashId([r.skill!.id, String(r.skill!.version)], 16)}`;
  const laidTrees = new Set<string>();
  const materializeSkillTree = async (handle: SandboxHandle, r: SkillResolution): Promise<void> => {
    const treeKey = `${handle.resourceId ?? handle.id}:${skillDir(skillsRoot(r), r)}`;
    if (laidTrees.has(treeKey)) return;
    try {
      const bundles = r.screenedBundles ?? (deps.skillBundles ? await loadActiveBundles(deps.skillBundles, [r]) : []);
      await laySkillTree(deps.sandbox, handle, skillsRoot(r), r, bundles);
      laidTrees.add(treeKey);
    } catch (err) {
      deps.errors?.record(
        tenant,
        {
          category: "skills",
          code: "tree_materialize_failed",
          message: errMessage(err),
          scopeLabel: scopeId,
          sessionId: sessionId,
        },
        err,
      );
      throw err;
    }
  };
  const useSkill = async (name: string, file: string, sandboxId?: string, source?: string): Promise<SkillResult> => {
    const missing = { content: null, sourceScopeId: null };
    if (!isSafeSkillName(name)) return missing;
    try {
      if (safeSkillFilePath(file) !== file) return missing;
    } catch {
      return missing;
    }
    const resolution = (await visibleSkillsForTurn(source ? [source] : undefined)).find(
      (r) => r.skill?.manifest.name === name,
    );
    if (!resolution?.skill) return missing;
    const shipsFiles = (resolution.skill.manifest.files?.length ?? 0) > 0 || resolution.skill.pack !== undefined;
    const asset = resolution.skill.manifest.files?.find((f) => {
      try {
        return safeSkillFilePath(f.path) === file;
      } catch {
        return false;
      }
    })?.content;
    if (file !== "SKILL.md" && asset === undefined) return missing;
    if (deps.skills)
      void deps.skills.recordUse(resolution.skill.id).catch((e) => swallow("orchestrator: skill recordUse", e));
    const render = (root?: string) =>
      file === "SKILL.md"
        ? renderSkillBody(resolution, root)
        : rehomeSkillPaths(resolution, asset!, root ?? skillsRoot(resolution));
    if (!shipsFiles) return { content: render(), sourceScopeId: resolution.skill.scopeId };
    const access = sandboxId !== undefined ? await accessResource(sandboxId) : undefined;
    if (access?.crossScope) return { content: render(skillsRoot(resolution)), sourceScopeId: resolution.skill.scopeId };
    const handle = access ? await provisionResource(access) : await provision();
    await materializeSkillTree(handle, resolution);
    const root = `${handle.rootDir}/${skillsRoot(resolution)}`;
    const pack = packRoot(root, resolution);
    return {
      content: render(root),
      sourceScopeId: resolution.skill.scopeId,
      dir: skillDir(root, resolution),
      ...(pack ? { packDir: pack } : {}),
    };
  };
  const pruneSkills = async (handle: SandboxHandle): Promise<void> => {
    const visible = (await visibleSkillsForTurn()).flatMap((r) => (r.skill ? [r.skill, ...r.shadowed] : []));
    const keep = new Set(visible.map((skill) => hashId([skill.id, String(skill.version)], 16)));
    const stale = new Set<string>();
    const listed = await deps.sandbox
      .listDir(handle, SKILLS_ROOT)
      .catch(swallowAs("orchestrator: list skills to prune", [] as string[]));
    for (const path of listed) {
      const [root, conversation, identity] = path.split("/");
      if (root === SKILLS_ROOT && conversation && identity && !keep.has(identity))
        stale.add(`${SKILLS_ROOT}/${conversation}/${identity}`);
    }
    await Promise.all(
      [...stale].map((dir) =>
        deps.sandbox.removeDir(handle, dir).catch(swallowAs("orchestrator: stale skill cleanup", undefined)),
      ),
    );
  };

  return { useSkill, pruneSkills, forgetLaidTrees: () => laidTrees.clear() };
}
