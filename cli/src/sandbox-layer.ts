import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { JUNK_FILE, deploymentLayerBundle } from "./deployment-layer.ts";
import { errMessage } from "./log.ts";
import { parseToolDescriptor, type ToolDescriptor } from "./tool-descriptor.ts";

const nested = (a: string, b: string): boolean => a.startsWith(`${b}/`);

export interface SkillFrontmatter {
  name: string;
  description: string;
  requiredCapabilities?: string[];
}

function stripSkillInlineComment(value: string): string {
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const prev = value[i - 1];
    const afterSpace = i === 0 || prev === " " || prev === "\t";
    if ((ch === '"' || ch === "'") && (afterSpace || prev === "[" || prev === ",")) {
      let close = i + 1;
      while (close < value.length) {
        if (ch === '"' && value[close] === "\\") close += 2;
        else if (value[close] !== ch) close++;
        else if (ch === "'" && value[close + 1] === "'") close += 2;
        else break;
      }
      if (close < value.length) i = close;
    } else if (ch === "#" && afterSpace) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

function stripSkillQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed[0] === '"' && trimmed.at(-1) === '"') || (trimmed[0] === "'" && trimmed.at(-1) === "'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function skillIndent(line: string): number {
  let indent = 0;
  while (indent < line.length && (line[indent] === " " || line[indent] === "\t")) indent++;
  return indent;
}

export function parseSkillFrontmatter(md: string, sourcePath: string): SkillFrontmatter {
  const source = md.startsWith("\uFEFF") ? md.slice(1) : md;
  const opening = /^---\r?\n/.exec(source);
  const closing = opening ? /\r?\n---/.exec(source.slice(opening[0].length)) : null;
  if (!opening || !closing) throw new Error(`${sourcePath}: missing YAML frontmatter (a leading --- … --- block)`);
  const contentStart = opening[0].length;
  const contentEnd = contentStart + closing.index;
  const body = source.slice(contentEnd + closing[0].length).replace(/^\s+/, "");
  if (!body.trim()) throw new Error(`${sourcePath}: skill requires a body below the frontmatter`);

  const fields: Record<string, unknown> = {};
  const lines = source.slice(contentStart, contentEnd).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const rest = stripSkillInlineComment(kv[2] ?? "");
    if (rest === ">" || rest === "|" || rest === ">-" || rest === "|-") {
      const literal = rest[0] === "|";
      const baseIndent = skillIndent(line);
      const collected: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        if (next.trim() && skillIndent(next) <= baseIndent) break;
        collected.push(next.trim() ? next.slice(Math.min(skillIndent(next), baseIndent + 2)) : "");
        i++;
      }
      fields[key] = (literal ? collected.join("\n") : collected.join(" ").replace(/\s+/g, " ")).trim();
      continue;
    }
    if (rest) {
      fields[key] =
        rest.startsWith("[") && rest.endsWith("]")
          ? rest.slice(1, -1).split(",").map(stripSkillQuotes).filter(Boolean)
          : stripSkillQuotes(rest);
      continue;
    }
    const baseIndent = skillIndent(line);
    const items: string[] = [];
    while (i + 1 < lines.length) {
      const next = lines[i + 1]!;
      if (!next.trim() || skillIndent(next) <= baseIndent) break;
      const item = /^\s*-\s+(.*)$/.exec(next);
      if (!item) break;
      items.push(stripSkillQuotes(stripSkillInlineComment(item[1]!)));
      i++;
    }
    fields[key] = items.filter(Boolean);
  }

  const name = fields["name"];
  const description = fields["description"];
  const requiredCapabilities = fields["requiredCapabilities"] ?? [];
  if (typeof name !== "string" || !name.trim()) throw new Error(`${sourcePath}: frontmatter is missing "name"`);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,126}[A-Za-z0-9_-])?$/.test(name)) {
    throw new Error(
      `${sourcePath}: skill name must be 1-128 ASCII letters, digits, dots, underscores, or hyphens; it must start with a letter or digit and cannot end with a dot`,
    );
  }
  if (typeof description !== "string" || !description.trim())
    throw new Error(`${sourcePath}: frontmatter is missing "description"`);
  if (
    !Array.isArray(requiredCapabilities) ||
    requiredCapabilities.some((capability) => typeof capability !== "string")
  ) {
    throw new Error(`${sourcePath}: frontmatter "requiredCapabilities" must be a YAML list`);
  }
  const out: SkillFrontmatter = { name, description };
  if (requiredCapabilities.length) out.requiredCapabilities = requiredCapabilities as string[];
  return out;
}

interface ToolEntry {
  dir: string;
  descriptorPath: string;
  descriptor: ToolDescriptor;
  binary: string;
  executablePath?: string;
}

interface SkillEntry {
  dir: string;
  skillPath: string;
  frontmatter: SkillFrontmatter;
}

export interface SandboxValidation {
  exists: boolean;
  hasDockerfile: boolean;
  tools: ToolEntry[];
  skills: SkillEntry[];
  errors: string[];
  warnings: string[];
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const subdirs = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
};

const isCidr = (host: string): boolean =>
  /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(host) || /^[0-9A-Fa-f:]+\/\d{1,3}$/.test(host);

export function validateSandboxLayer(sandboxDir: string): SandboxValidation {
  const out: SandboxValidation = {
    exists: existsSync(sandboxDir),
    hasDockerfile: existsSync(join(sandboxDir, "Dockerfile")),
    tools: [],
    skills: [],
    errors: [],
    warnings: [],
  };

  const toolsDir = join(sandboxDir, "tools");
  const idCounts = new Map<string, number>();
  for (const name of subdirs(toolsDir)) {
    const descriptorPath = join(toolsDir, name, "tool.json");
    if (!existsSync(descriptorPath)) {
      out.errors.push(`tools/${name}/ has no tool.json`);
      continue;
    }
    let descriptor: ToolDescriptor;
    try {
      descriptor = parseToolDescriptor(readFileSync(descriptorPath, "utf8"), `tools/${name}/tool.json`);
    } catch (e) {
      out.errors.push(errMessage(e));
      continue;
    }
    idCounts.set(descriptor.id, (idCounts.get(descriptor.id) ?? 0) + 1);
    for (const { path } of descriptor.auth?.credentialPaths ?? []) {
      if (path === ".ssh" || path.startsWith(".ssh/")) {
        out.warnings.push(
          `tool "${descriptor.id}" captures sensitive credential path ${JSON.stringify(path)}; keep it only if the whole SSH identity is required`,
        );
      }
    }
    for (const host of descriptor.egress ?? []) {
      if (host.includes("*") || host === "0.0.0.0/0" || host === "::/0") {
        out.warnings.push(
          `tool "${descriptor.id}" declares broad egress ${JSON.stringify(host)}; egress is validated-only in contract v1`,
        );
      }
      if (/^[a-z]+:\/\//i.test(host) || (host.includes("/") && !isCidr(host))) {
        out.errors.push(
          `tool "${descriptor.id}" egress ${JSON.stringify(host)} must name a host or a CIDR range, not a URL or path`,
        );
      }
    }
    const binaryName = descriptor.install?.binary ?? descriptor.id;
    const exePath = join(toolsDir, name, binaryName);
    const hasExe = isFile(exePath);
    const installed = descriptor.install?.files ?? [];
    for (const file of installed) {
      if (!isFile(join(toolsDir, name, file.from))) {
        out.errors.push(
          `tool "${descriptor.id}" declares install file "${file.from}" but tools/${name}/${file.from} is not a regular file`,
        );
      }
    }
    const deliversBinary = installed.some((file) => file.to === `/usr/local/bin/${binaryName}`);
    if (!hasExe && !deliversBinary && !out.hasDockerfile) {
      out.errors.push(
        `tool "${descriptor.id}" (tools/${name}/) can't get its binary on PATH: ship an executable ` +
          `"${binaryName}" in the folder, declare it under install.files, or add a sandbox/Dockerfile that installs it`,
      );
    }
    const entry: ToolEntry = { dir: name, descriptorPath, descriptor, binary: binaryName };
    if (hasExe) entry.executablePath = exePath;
    out.tools.push(entry);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) out.errors.push(`duplicate tool id "${id}" (declared by ${count} tool.json files)`);
  }
  const layerLinks = out.tools.flatMap((t) =>
    (t.descriptor.auth?.credentialPaths ?? []).map((entry) => ({ id: t.descriptor.id, ...entry })),
  );
  for (const a of layerLinks) {
    const b = layerLinks.find(
      (other) =>
        other !== a &&
        (a.path === other.path ? a.kind !== other.kind : nested(a.path, other.path) || nested(other.path, a.path)),
    );
    if (b) {
      out.errors.push(
        `tools "${a.id}" and "${b.id}" declare incompatible credential paths ${JSON.stringify(a.path)} and ${JSON.stringify(b.path)} — declare matching kinds for shared paths or disjoint paths`,
      );
    }
  }

  const skillsDir = join(sandboxDir, "skills");
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !JUNK_FILE.test(entry.name)) {
        out.errors.push(
          `skills/${entry.name} is not a skill directory; the core only accepts skills/<id>/<file> paths`,
        );
      }
    }
  }
  for (const name of subdirs(skillsDir)) {
    const skillPath = join(skillsDir, name, "SKILL.md");
    if (!existsSync(skillPath)) {
      out.errors.push(`skills/${name}/ has no SKILL.md`);
      continue;
    }
    try {
      const frontmatter = parseSkillFrontmatter(readFileSync(skillPath, "utf8"), `skills/${name}/SKILL.md`);
      out.skills.push({ dir: name, skillPath, frontmatter });
    } catch (e) {
      out.errors.push(errMessage(e));
    }
  }

  if (out.exists && out.errors.length === 0) {
    try {
      const body = JSON.stringify(deploymentLayerBundle(sandboxDir));
      if (Buffer.byteLength(body) > 1_000_000) {
        out.errors.push("deployment layer (skills/ + tool descriptors) exceeds the core API's 1 MB request limit");
      }
    } catch (e) {
      out.errors.push(errMessage(e));
    }
  }

  return out;
}
