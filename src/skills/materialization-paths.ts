export const SKILLS_DIR = "skills";
export const SKILLS_INDEX_MARKER = `${SKILLS_DIR}/.index`;
export const SKILL_TREE_MARKER = ".tree";

export function isSkillMaterializationControlPath(path: string): boolean {
  if (path === SKILLS_INDEX_MARKER || path.startsWith(`${SKILLS_INDEX_MARKER}/`)) return true;
  const parts = path.split("/");
  return parts.length >= 3 && parts[0] === SKILLS_DIR && parts[2] === SKILL_TREE_MARKER;
}
