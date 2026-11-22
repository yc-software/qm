import { parseFrontmatter } from "../../cli/src/frontmatter.ts";
import { assertSafeSkillName } from "./skill-name.ts";

export { parseFrontmatter };

export function parseSeedSkillFrontmatter(raw: string): {
  name: string;
  description: string;
  requiredCapabilities: string[];
  body: string;
} {
  const { attrs, body } = parseFrontmatter(raw);
  const name = typeof attrs.name === "string" ? attrs.name.trim() : attrs.name;
  const description = typeof attrs.description === "string" ? attrs.description.trim() : attrs.description;
  const requiredCapabilities = attrs.requiredCapabilities ?? [];
  if (typeof name !== "string" || !name) throw new Error("seed skill requires name");
  assertSafeSkillName(name);
  if (typeof description !== "string" || !description) throw new Error(`seed skill ${name} requires description`);
  if (!Array.isArray(requiredCapabilities) || !requiredCapabilities.every((c): c is string => typeof c === "string")) {
    throw new Error(`seed skill ${name} requiredCapabilities must be a list of strings`);
  }
  if (!body.trim()) throw new Error(`seed skill ${name} requires a body`);
  return { name, description, requiredCapabilities, body };
}
