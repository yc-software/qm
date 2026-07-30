import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  CONFIG_FILENAME,
  configPathInDir,
  loadConfigAt,
  validOrgId,
  type ModelProvider,
  type Target,
  type QmConfig,
} from "../config.ts";
import { die, note, ok, warn } from "../log.ts";
import { assertNodeEngine } from "../preflight.ts";
import { cliPackageName, cliVersion } from "../manifest.ts";
import { computedSecrets, renderEnvExample } from "../secrets.ts";
import { renderSlackManifests, usesSlackOidc } from "../slack-manifests.ts";
import { hostingProvider } from "../backends/registry.ts";

const AGENTS_TEMPLATE = `# QM deployment

This directory is one QM deployment: a config, a secret contract, and a
sandbox layer that customizes the agent without forking the core images. Commit
everything here except \`.env\`, which holds the secret values and is covered by
the scaffolded \`.gitignore\`.

## Where the documentation lives

- \`package.json\` pins the exact CLI version this directory is interpreted by,
  so every checkout resolves the same \`qm\`. \`contract\` in the config is only
  the coarse compatibility floor; this pin is the reproducible one. Upgrade it
  deliberately and re-run \`qm check\` afterwards.
- \`qm.config.jsonc\` describes what to run. Every field carries a comment
  explaining it, including the full list of services, so read the file itself
  before changing it. It is JSON with comments (the \`tsconfig.json\` dialect).
  That applies only to the config: \`tool.json\` files must stay strict JSON.
- \`.env.example\` is the secret catalog. It lists every secret the platform
  knows, what each one is for, what enables it, and the command that produces a
  value when one exists. The secrets the current config needs appear uncommented.
  \`qm init\` creates a gitignored \`.env\`, generates its local signing
  keys, and leaves provider credentials blank for you to fill in. Never write a
  secret value into any other file.
- \`slack-app-manifest.yml\` creates the optional qm bot app. Slack OIDC
  deployments also get \`slack-sso-manifest.yml\`. Run
  \`npm exec qm -- slack render\` after changing \`publicUrl\`, then
  \`npm exec qm -- outputs\` for creation links.

## Customizing the sandbox

\`sandbox/\` defines what the agent gets in its execution environment:

- A skill is \`sandbox/skills/<id>/SKILL.md\`: markdown with \`name\` and
  \`description\` frontmatter that teaches the agent a workflow and when to use it.
- A tool is \`sandbox/tools/<id>/tool.json\`: a descriptor whose minimal form is
  \`{ "id": ..., "advertise": ..., "install": { "binary": ... } }\`, with the
  executable next to it when the binary is not already in the base image.
- \`sandbox/Dockerfile\` is optional and only needed for system packages or
  runtimes.

The scaffold ships a working example, the \`greet\` skill and \`example-tool\`.
Copy its shape, then replace or delete it.

## The workflow

Run every command from this directory.

1. \`npm exec qm -- check\` validates the config and the sandbox layer and prints the
   secret names the config currently requires. It builds nothing, and when
   credential values are already present in \`.env\` it also verifies them
   against their providers, so run it after every edit.
2. \`npm exec qm -- plan\` reports what deployment would do
   without changing anything.
3. After the target prerequisites are complete, \`npm exec qm -- up\` brings the
   deployment up and prints the URLs. An AWS directory must first complete the
   edge and authenticated-portal steps in its AWS bootstrap section below.
   \`--build-from <path to a QM checkout>\` is reserved for contributors
   testing unreleased runtime code.
4. \`npm exec qm -- status\`, \`npm exec qm -- logs [service]\`, and
   \`npm exec qm -- down\` show
   what is running, tail logs, and stop the deployment.
5. \`npm exec qm -- secrets push\` uploads the \`.env\` values to the deploy target.
   The docker target reads \`.env\` directly and does not need it.

\`npm exec qm -- help\` lists everything else, including \`sandbox build\` and
\`rollback\`.
`;

const GREET_SKILL = `---
name: greet
description: Greet a teammate by name. Use whenever asked to say hello to someone.
---
Run \`example-tool <name>\` to greet someone, e.g. \`example-tool Ada\`.
`;

const EXAMPLE_TOOL_DESCRIPTOR =
  JSON.stringify({ id: "example-tool", advertise: "example-tool", install: { binary: "example-tool" } }, null, 2) +
  "\n";

const EXAMPLE_TOOL_BIN = `#!/usr/bin/env bash
echo "Hello, \${1:-world}!"
`;

function writeIfAbsent(dir: string, segments: string[], content: string, mode?: number): void {
  const abs = join(dir, ...segments);
  const rel = segments.join("/");
  if (existsSync(abs)) {
    warn(`${rel} already exists — left it untouched`);
    return;
  }
  mkdirSync(dirname(abs), { recursive: true });
  if (mode === undefined) writeFileSync(abs, content);
  else writeFileSync(abs, content, { mode });
  if (mode !== undefined) chmodSync(abs, mode);
  ok(`wrote ${rel}`);
}

function scaffoldSandbox(dir: string): void {
  writeIfAbsent(dir, ["sandbox", "skills", "greet", "SKILL.md"], GREET_SKILL);
  writeIfAbsent(dir, ["sandbox", "tools", "example-tool", "tool.json"], EXAMPLE_TOOL_DESCRIPTOR);
  writeIfAbsent(dir, ["sandbox", "tools", "example-tool", "example-tool"], EXAMPLE_TOOL_BIN, 0o755);
}

function ensureGitignore(dir: string, rules: readonly string[]): void {
  const path = join(dir, ".gitignore");
  const scaffold = `${rules.join("\n")}\n`;
  if (!existsSync(path)) {
    writeIfAbsent(dir, [".gitignore"], scaffold);
    return;
  }
  const current = readFileSync(path, "utf8");
  const existing = new Set(current.split(/\r?\n/));
  const missing = rules.filter((rule) => rule !== ".env" && !existing.has(rule));
  const lastRule = current
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (lastRule !== ".env") missing.push(".env");
  if (!missing.length) {
    ok(".gitignore already covers generated and secret state");
    return;
  }
  writeFileSync(path, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  ok("updated .gitignore");
}

function envPathIsTracked(dir: string): boolean {
  return spawnSync("git", ["-C", dir, "ls-files", "--error-unmatch", "--", ".env"], { stdio: "ignore" }).status === 0;
}

function initialEnv(config: QmConfig): string {
  const generated = new Map(
    computedSecrets(config)
      .filter((secret) => secret.generate === "openssl rand -hex 32")
      .map((secret) => [secret.name, randomBytes(32).toString("hex")]),
  );
  return renderEnvExample(config)
    .replace(
      "# Secret values for this deployment. This file holds names only; copy it to .env and fill in",
      "# Secret values for this deployment. Local signing keys were generated; fill in the blanks",
    )
    .replace(/^([A-Z][A-Z0-9_]*)=$/gm, (line, name: string) => {
      const value = generated.get(name);
      return value ? `${name}=${value}` : line;
    });
}

function template(rel: string): string {
  const source = new URL(`../../templates/${rel}`, import.meta.url);
  const packaged = new URL(`../../../templates/${rel}`, import.meta.url);
  return readFileSync(existsSync(source) ? source : packaged, "utf8");
}

function packageContent(dir: string, orgId: string): string {
  const packagePath = join(dir, "package.json");
  let existing: Record<string, unknown> = {};
  const exists = existsSync(packagePath);
  if (exists) {
    try {
      const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        die(`${packagePath} must contain a JSON object`);
      existing = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof SyntaxError) die(`${packagePath} is not valid JSON: ${error.message}`);
      throw error;
    }
  }
  const objectField = (name: string): Record<string, unknown> => {
    const value = existing[name];
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  };
  const scripts = {
    qm: "qm",
    check: "qm check",
    plan: "qm plan",
    deploy: "qm up",
    status: "qm status",
    conformance: "qm conformance --static",
    ...objectField("scripts"),
  };
  const engines = { ...objectField("engines"), node: ">=24.0.0" };
  const packageName = cliPackageName();
  const dependencies = objectField("dependencies");
  const installedPackage = typeof dependencies[packageName] === "string" ? dependencies[packageName] : cliVersion();
  delete dependencies["qm-cli"];
  delete dependencies[packageName];
  for (const group of ["devDependencies", "optionalDependencies"] as const) {
    const groupDependencies = objectField(group);
    if ("qm-cli" in groupDependencies || packageName in groupDependencies) {
      delete groupDependencies["qm-cli"];
      delete groupDependencies[packageName];
      existing[group] = groupDependencies;
    }
  }
  existing["dependencies"] = {
    ...dependencies,
    [packageName]: installedPackage,
  };
  const packageJson = {
    ...(exists ? {} : { name: `${orgId}-qm-deployment`, version: "0.0.0" }),
    ...existing,
    private: true,
    engines,
    scripts,
  };
  return `${JSON.stringify(packageJson, null, 2)}\n`;
}

function writePackage(dir: string, content: string): void {
  const path = join(dir, "package.json");
  if (!existsSync(path)) {
    writeIfAbsent(dir, ["package.json"], content);
    return;
  }
  writeFileSync(path, content);
  ok("updated package.json");
}

function scaffoldDeploymentSkill(dir: string): void {
  const files = [
    ["deployment.md"],
    [".codex", "skills", "deploy-qm", "SKILL.md"],
    [".codex", "skills", "deploy-qm", "agents", "openai.yaml"],
    ...["fly", "aws", "slack", "email"].map((name) => [".codex", "skills", "deploy-qm", "references", `${name}.md`]),
  ];
  for (const segments of files) {
    const source =
      segments[segments.length - 1] === "deployment.md"
        ? "deployment/deployment.md"
        : `deployment/${segments.slice(3).join("/")}`;
    writeIfAbsent(dir, segments, template(source));
  }
}

export function runInit(opts: { org?: string; target?: Target; modelProvider?: ModelProvider; dir?: string }): void {
  assertNodeEngine();
  const orgId = opts.org ?? "default-org";
  if (!validOrgId(orgId)) die(`--org must be a lowercase DNS label (a-z, 0-9, and hyphens between)`);
  const dir = opts.dir ?? process.cwd();
  const configPath = join(dir, CONFIG_FILENAME);
  const existingConfigPath = configPathInDir(dir);
  if (existingConfigPath) die(`${existingConfigPath} already exists — refusing to overwrite.`);
  const preparedPackage = packageContent(dir, orgId);

  mkdirSync(dir, { recursive: true });
  if (envPathIsTracked(dir)) {
    die(`${join(dir, ".env")} is tracked by Git — refusing to generate signing keys into it`);
  }

  const target: Target = opts.target ?? "docker";
  const modelProvider: ModelProvider = opts.modelProvider ?? "anthropic";
  const provider = hostingProvider(target);
  writeFileSync(configPath, provider.scaffold.renderConfig(orgId, modelProvider));
  ok(`wrote ${CONFIG_FILENAME} (orgId=${orgId}, target=${target}, modelProvider=${modelProvider})`);

  const config = loadConfigAt(configPath).config;
  writePackage(dir, preparedPackage);
  writeIfAbsent(dir, [".env.example"], renderEnvExample(config));
  ensureGitignore(dir, provider.scaffold.ignores);
  writeIfAbsent(dir, [".env"], initialEnv(config), 0o600);
  writeIfAbsent(dir, ["AGENTS.md"], AGENTS_TEMPLATE + provider.scaffold.agentsAppendix);
  scaffoldDeploymentSkill(dir);
  const manifests = renderSlackManifests(config);
  writeIfAbsent(dir, ["slack-app-manifest.yml"], manifests.bot);
  if (usesSlackOidc(config)) writeIfAbsent(dir, ["slack-sso-manifest.yml"], manifests.sso);
  scaffoldSandbox(dir);
  for (const file of provider.scaffold.files(config)) writeIfAbsent(dir, file.segments, file.content);

  note("");
  note(`CLI ${cliVersion()} selects immutable runtime image digests from its release manifest.`);
  note(`AGENTS.md explains this directory and how to customize the deployment.`);
  note("");
  note("Next:");
  const rel = relative(realpathSync(process.cwd()), realpathSync(dir));
  if (rel) note(`  cd ${rel.startsWith("..") || isAbsolute(rel) ? resolve(dir) : rel}`);
  const step = (n: number, cmd: string, why: string): void => note(`  ${n}. ${cmd.padEnd(38)} # ${why}`);
  step(1, `npm install`, `install the exact package dependency and write the lockfile`);
  step(2, `$EDITOR ${CONFIG_FILENAME}`, `confirm provider, identity, services; optionally pin a model`);
  note(`     (${provider.scaffold.configurationHint})`);
  step(3, `npm exec qm -- setup`, `guided: walk the configured secrets interactively`);
  note(`     (or $EDITOR .env to fill them by hand; local signing keys are generated)`);
  step(4, `npm exec qm -- check`, `validate the config and sandbox/`);
  step(5, provider.scaffold.finalCommand, provider.scaffold.finalWhy);
}
