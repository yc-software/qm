const SAFE_SKILL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,126}[A-Za-z0-9_-])?$/;

export function isSafeSkillName(name: string): boolean {
  return SAFE_SKILL_NAME.test(name);
}

export function assertSafeSkillName(name: string): string {
  if (!isSafeSkillName(name)) {
    throw new Error(
      "skill name must be 1-128 ASCII letters, digits, dots, underscores, or hyphens; it must start with a letter or digit and cannot end with a dot",
    );
  }
  return name;
}
