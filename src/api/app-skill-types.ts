import type { ScopeId } from "../types.ts";
import type { IngestPlan, ImportResult } from "../skills/ingest.ts";
import type { NewSkillPack, SkillPack } from "../skills/skill-pack-store.ts";
import type { Skill, SkillListing, SkillResolution } from "../skills/skill-store.ts";

export interface SkillMethods {
  listSkills(only?: SkillListing): Promise<Skill[]>;
  getSkill(id: string): Promise<Skill | null>;
  archiveSkill(id: string): Promise<Skill>;
  listVisibleSkills(principalId: string): Promise<SkillResolution[]>;
  canManageSkill(skill: Skill, principalId: string): Promise<boolean>;
  updateOwnedSkill(
    id: string,
    principalId: string,
    patch: { description?: string; body?: string },
    opts?: { liveActor?: boolean },
  ): Promise<Skill | "trigger_blocked" | null>;
  restoreOwnedSkill(id: string, principalId: string): Promise<Skill | null>;
  listSkillPacks(): Promise<SkillPack[]>;
  getSkillPack(id: string): Promise<SkillPack | null>;
  registerSkillPack(input: NewSkillPack): Promise<SkillPack>;
  updateSkillPack(id: string, patch: Partial<Omit<SkillPack, "id" | "createdAt">>): Promise<SkillPack>;
  skillPackCatalog(id: string): Promise<IngestPlan & { bundlePaths: string[] }>;
  importSkillPack(id: string, selected: "all" | string[], scopeIds?: ScopeId[]): Promise<ImportResult>;
  syncSkillPack(id: string): Promise<ImportResult>;
  removeSkillPack(id: string): Promise<{ removed: number }>;
  createOwnedSkill(input: {
    principalId: string;
    homeScope?: ScopeId;
    name: string;
    description: string;
    body: string;
    requiredCapabilities?: string[];
  }): Promise<Skill | null>;
  deleteOwnedSkill(input: {
    principalId: string;
    id: string;
    liveActor?: boolean;
  }): Promise<"missing" | "forbidden" | "trigger_blocked" | "deleted">;
}
