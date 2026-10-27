import { parse } from "yaml";
import { z } from "zod";
import { assertSafeSkillName } from "./skill-name.ts";
import { errMessage } from "../util/errors.ts";

export interface Frontmatter {
  attrs: Record<string, unknown>;
  body: string;
}

const attrsSchema = z.record(z.string(), z.unknown()).catch({});

export function parseFrontmatter(raw: string): Frontmatter {
  if (!/^\uFEFF?---\r?\n/.test(raw)) throw new Error("frontmatter: file must start with a --- fence");
  const fenced = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/.exec(raw);
  if (!fenced) throw new Error("frontmatter: --- fence is not closed");
  let attrs: unknown;
  try {
    attrs = parse(fenced[1]!, { schema: "failsafe", logLevel: "error" });
  } catch (e) {
    throw new Error(`frontmatter is not valid YAML: ${errMessage(e)}`, { cause: e });
  }
  return { attrs: attrsSchema.parse(attrs), body: fenced[2]!.trimStart() };
}

const seedSkillSchema = z.object({
  name: z
    .string()
    .refine((name) => name.trim() !== "")
    .transform(assertSafeSkillName),
  description: z.string("requires description").trim().min(1, "requires description"),
  requiredCapabilities: z
    .preprocess(
      (value) => (value === "" ? [] : value),
      z.array(
        z.string("requiredCapabilities must be a list of strings"),
        "requiredCapabilities must be a list of strings",
      ),
    )
    .default([]),
});

export function parseSeedSkillFrontmatter(raw: string): z.infer<typeof seedSkillSchema> & { body: string } {
  const { attrs, body } = parseFrontmatter(raw);
  const parsed = seedSkillSchema.safeParse(attrs);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(
      issue.path[0] === "name" ? "seed skill requires name" : `seed skill ${attrs.name} ${issue.message}`,
    );
  }
  if (!body.trim()) throw new Error(`seed skill ${parsed.data.name} requires a body`);
  return { ...parsed.data, body };
}
