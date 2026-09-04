import type { SkillItem } from "./composer";

export type SkillStatusFilter = "active" | "archived" | "all";

export interface SkillRegistryFilters {
  query: string;
  scope: string;
  source: string;
  status: SkillStatusFilter;
}

export interface SkillGroup {
  name: string;
  skills: SkillItem[];
}

export type SkillEmptyState = "none" | "loading" | "filtered" | "empty";

const SCOPE_ORDER = new Map([
  ["personal", 0],
  ["channel", 1],
  ["group", 2],
  ["team", 3],
  ["org", 4],
]);

export function isArchivedSkill(skill: SkillItem): boolean {
  return skill.status === "archived";
}

export function filterSkills(skills: readonly SkillItem[], filters: SkillRegistryFilters): SkillItem[] {
  const query = filters.query.trim().toLowerCase();
  return skills.filter((skill) => {
    if (filters.status !== "all" && (isArchivedSkill(skill) ? "archived" : "active") !== filters.status) return false;
    if (filters.scope !== "all" && skill.scope !== filters.scope) return false;
    if (filters.source === "overrides" ? !skill.shadowed : filters.source !== "all" && skill.source !== filters.source)
      return false;
    if (!query) return true;
    return [skill.name, skill.description, skill.scope, skill.scopeId, skill.pack?.upstreamName]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
}

export function groupSkills(skills: readonly SkillItem[]): SkillGroup[] {
  const groups = new Map<string, SkillItem[]>();
  for (const skill of skills) {
    const key = skill.name;
    const variants = groups.get(key) ?? [];
    variants.push(skill);
    groups.set(key, variants);
  }
  return [...groups.values()]
    .map((variants) => {
      variants.sort((a, b) => {
        const archived = Number(isArchivedSkill(a)) - Number(isArchivedSkill(b));
        if (archived) return archived;
        return (SCOPE_ORDER.get(a.scope) ?? 99) - (SCOPE_ORDER.get(b.scope) ?? 99);
      });
      return { name: variants[0]!.name, skills: variants };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function filterSkillGroups(groups: readonly SkillGroup[], filters: SkillRegistryFilters): SkillGroup[] {
  return groups.flatMap((group) => {
    const activeVariants = group.skills.filter((skill) => !isArchivedSkill(skill)).length;
    if (filters.source === "overrides" && activeVariants < 2) return [];
    const skills = filterSkills(group.skills, filters.source === "overrides" ? { ...filters, source: "all" } : filters);
    return skills.length ? [{ ...group, skills }] : [];
  });
}

export function skillEmptyState(total: number, visible: number, loading: boolean): SkillEmptyState {
  if (loading && total === 0) return "loading";
  if (visible > 0) return "none";
  return total > 0 ? "filtered" : "empty";
}

export function statusCounts(skills: readonly SkillItem[]): { active: number; archived: number; all: number } {
  const archived = skills.filter(isArchivedSkill).length;
  return { active: skills.length - archived, archived, all: skills.length };
}
