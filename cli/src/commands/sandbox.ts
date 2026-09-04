import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CliError, bold, die, errMessage, header, note, ok, warn } from "../log.ts";
import { updateConfigSandbox, type QmConfig } from "../config.ts";
import { sandboxBaseRef } from "../manifest.ts";
import { validateSandboxLayer, type SandboxValidation } from "../sandbox-layer.ts";
import { deploymentSecretValue, flyBin, readEnvFile } from "../util.ts";

const SANDBOX_RUNTIME_PLATFORM = "linux/amd64";

export interface SandboxBuildOpts {
  sandboxDir: string;
  config: QmConfig;
  from?: string;
  tag?: string;
  dryRun?: boolean;
  app?: string;
}

export interface SandboxPublishOpts extends SandboxBuildOpts {
  configPath: string;
  app?: string;
  envFile?: string;
}

interface PreparedBuild {
  sandboxDir: string;
  dockerfilePath: string;
  dockerfileBody: string;
  base: string;
  layer: SandboxValidation;
  binaries: string[];
  hasCustom: boolean;
}

interface DockerfileLogicalLine {
  text: string;
  start: number;
  end: number;
}

interface DockerfileFrom extends DockerfileLogicalLine {
  platform?: string;
  ref: string;
  alias?: string;
  refStart: number;
}

const FROM_RE = /^(\s*FROM\s+(?:--platform=(\S+)\s+)?)(\S+)(?:\s+AS\s+(\S+))?(?:\s+#.*)?\s*$/i;

interface DockerfileHeredoc {
  delimiter: string;
  stripTabs: boolean;
}

function dockerfileHeredocs(instruction: string): DockerfileHeredoc[] {
  const body = instruction.match(/^\s*(?:ONBUILD\s+)?(?:RUN|COPY|ADD)\b([\s\S]*)$/i)?.[1];
  if (body === undefined) return [];
  const out: DockerfileHeredoc[] = [];
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"') i++;
      continue;
    }
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(body[i - 1]!))) break;
    if (char !== "<" || body[i + 1] !== "<" || body[i + 2] === "<") continue;
    i += 2;
    const stripTabs = body[i] === "-";
    if (stripTabs) i++;
    let delimiter = "";
    let delimiterQuote: "'" | '"' | undefined;
    let consumed = false;
    for (; i < body.length; i++) {
      const delimiterChar = body[i]!;
      if (delimiterQuote) {
        consumed = true;
        if (delimiterChar === delimiterQuote) {
          delimiterQuote = undefined;
        } else if (delimiterChar === "\\" && delimiterQuote === '"') {
          const next = body[i + 1];
          if (next === undefined) throw new CliError(`sandbox/Dockerfile has a malformed heredoc delimiter`);
          if ('$`"\\\n'.includes(next)) {
            delimiter += next;
            i++;
          } else {
            delimiter += delimiterChar;
          }
        } else {
          delimiter += delimiterChar;
        }
        continue;
      }
      if (/\s|[;&|<>]/.test(delimiterChar)) break;
      consumed = true;
      if (delimiterChar === "'" || delimiterChar === '"') {
        delimiterQuote = delimiterChar;
      } else if (delimiterChar === "\\") {
        const next = body[++i];
        if (next === undefined) throw new CliError(`sandbox/Dockerfile has a malformed heredoc delimiter`);
        delimiter += next;
      } else {
        delimiter += delimiterChar;
      }
    }
    if (!consumed || delimiterQuote || !delimiter)
      throw new CliError(`sandbox/Dockerfile has a malformed heredoc delimiter`);
    i--;
    out.push({ delimiter, stripTabs });
  }
  return out;
}

function dockerfileLogicalLines(body: string): DockerfileLogicalLine[] {
  const physical = body.match(/[^\n]*(?:\n|$)/g)?.filter((line) => line.length > 0) ?? [];
  let escape = "\\";
  let offset = 0;
  let pending = "";
  let pendingStart = 0;
  const out: DockerfileLogicalLine[] = [];
  let sawInstruction = false;

  for (let physicalIndex = 0; physicalIndex < physical.length; physicalIndex++) {
    const raw = physical[physicalIndex]!;
    const start = offset;
    offset += raw.length;
    const line = raw.endsWith("\n") ? raw.slice(0, -1).replace(/\r$/, "") : raw.replace(/\r$/, "");
    if (!pending && !sawInstruction) {
      const directive = line.match(/^#\s*escape=(\\|`)\s*$/i);
      if (directive) escape = directive[1]!;
      if (line.trim() && !line.trimStart().startsWith("#")) sawInstruction = true;
    }
    let escapes = 0;
    for (let i = line.length - 1; i >= 0 && line[i] === escape; i--) escapes++;
    const continued = escapes % 2 === 1;
    if (!pending) pendingStart = start;
    pending += continued ? `${line.slice(0, -1)} ` : line;
    if (continued) continue;
    const instruction = { text: pending, start: pendingStart, end: offset };
    out.push(instruction);
    pending = "";
    for (const heredoc of dockerfileHeredocs(instruction.text)) {
      let terminated = false;
      while (++physicalIndex < physical.length) {
        const heredocRaw = physical[physicalIndex]!;
        offset += heredocRaw.length;
        const heredocLine = heredocRaw.endsWith("\n")
          ? heredocRaw.slice(0, -1).replace(/\r$/, "")
          : heredocRaw.replace(/\r$/, "");
        const terminator = heredoc.stripTabs ? heredocLine.replace(/^\t+/, "") : heredocLine;
        if (terminator === heredoc.delimiter) {
          terminated = true;
          break;
        }
      }
      if (!terminated)
        throw new CliError(`sandbox/Dockerfile has an unterminated heredoc ${JSON.stringify(heredoc.delimiter)}`);
    }
  }
  if (pending) throw new CliError("sandbox/Dockerfile has an unterminated line continuation");
  return out;
}

function dockerfileFroms(body: string): DockerfileFrom[] {
  const froms: DockerfileFrom[] = [];
  for (const line of dockerfileLogicalLines(body)) {
    if (!/^\s*FROM(?:\s|$)/i.test(line.text)) continue;
    const match = line.text.match(FROM_RE);
    if (!match)
      throw new CliError(`sandbox/Dockerfile has an unsupported or malformed FROM instruction: ${line.text.trim()}`);
    froms.push({
      ...line,
      ...(match[2] ? { platform: match[2] } : {}),
      ref: match[3]!,
      ...(match[4] ? { alias: match[4] } : {}),
      refStart: match[1]!.length,
    });
  }
  if (!froms.length) throw new CliError("sandbox/Dockerfile must contain a FROM instruction");
  return froms;
}

function externalDockerfileBases(body: string): string[] {
  const stages = new Set<string>();
  const bases: string[] = [];
  for (const { ref, alias } of dockerfileFroms(body)) {
    if (ref.toLowerCase() !== "scratch" && !stages.has(ref.toLowerCase())) bases.push(ref);
    if (alias) stages.add(alias.toLowerCase());
  }
  return bases;
}

function replaceDockerfileBase(body: string, from: string, to: string): string {
  const edits = dockerfileFroms(body)
    .filter((instruction) => instruction.ref === from)
    .map((instruction) => {
      const text =
        instruction.text.slice(0, instruction.refStart) +
        to +
        instruction.text.slice(instruction.refStart + instruction.ref.length);
      return {
        start: instruction.start,
        end: instruction.end,
        text: `${text}${body.slice(instruction.start, instruction.end).endsWith("\n") ? "\n" : ""}`,
      };
    })
    .sort((a, b) => b.start - a.start);
  let out = body;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

function finalStagePlatform(body: string): string | undefined {
  const stages = new Map<string, string | undefined>();
  let final: string | undefined;
  for (const { ref, alias, platform } of dockerfileFroms(body)) {
    final = platform ?? stages.get(ref.toLowerCase());
    if (alias) stages.set(alias.toLowerCase(), final);
  }
  return final;
}

function assertPublishPlatform(body: string): void {
  const platform = finalStagePlatform(body);
  if (
    platform === undefined ||
    platform.toLowerCase() === SANDBOX_RUNTIME_PLATFORM ||
    platform === "$TARGETPLATFORM" ||
    platform === "${TARGETPLATFORM}"
  )
    return;
  throw new CliError(
    `sandbox/Dockerfile final stage forces ${platform}, but contract v1 sandbox machines require ${SANDBOX_RUNTIME_PLATFORM}; ` +
      `remove the final FROM --platform override or use --platform=$TARGETPLATFORM`,
  );
}

function prepare(opts: SandboxBuildOpts): PreparedBuild {
  const sandboxDir = resolve(opts.sandboxDir);
  const layer = validateSandboxLayer(sandboxDir);
  if (layer.errors.length) {
    throw new CliError(`sandbox check failed:\n${layer.errors.map((error) => `  - ${error}`).join("\n")}`);
  }
  const customDockerfile = join(sandboxDir, "Dockerfile");
  const hasCustom = existsSync(customDockerfile);
  if (!hasCustom && layer.tools.length === 0) {
    die(`nothing to build in ${sandboxDir}: add a tool executable under tools/, or a sandbox/Dockerfile.`);
  }
  const binaries = layer.tools.map((tool) => tool.binary);
  const presenceCheck = binaries.length
    ? `RUN for b in ${binaries.map((binary) => `'${binary}'`).join(" ")}; do command -v "$b" >/dev/null 2>&1 || { echo "sandbox build: tool binary $b is not on PATH" >&2; exit 1; }; done\n`
    : "";
  let base = opts.from ?? opts.config.sandbox?.baseImage ?? sandboxBaseRef();
  let dockerfileBody: string;
  if (hasCustom) {
    if (opts.from) warn("--from is ignored: sandbox/Dockerfile sets its own base image.");
    dockerfileBody = readFileSync(customDockerfile, "utf8").replace(/\n*$/, "\n") + presenceCheck;
    const declared = externalDockerfileBases(dockerfileBody);
    if (declared.some((ref) => ref.includes("$")))
      throw new CliError(
        "sandbox/Dockerfile FROM variables cannot be provenance-pinned; use an explicit image reference",
      );
    const mutable = [...new Set(declared.filter((ref) => !ref.includes("@sha256:")))];
    if (mutable.length > 1)
      throw new CliError("sandbox/Dockerfile has multiple mutable external base images; pin all but one by digest");
    if (mutable[0]) {
      const pin = opts.config.sandbox?.baseImage;
      if (pin && pin.split("@")[0] === mutable[0]) {
        dockerfileBody = replaceDockerfileBase(dockerfileBody, mutable[0], pin);
        base = pin;
      } else {
        base = mutable[0];
      }
    } else if (declared[0]) base = declared[0];
    else base = "scratch";
  } else {
    const copies = layer.tools
      .filter((tool) => tool.executablePath)
      .map((tool) => `COPY tools/${tool.dir}/${tool.binary} /usr/local/bin/${tool.binary}`)
      .join("\n");
    dockerfileBody = `FROM ${base}\n${copies}\nRUN chmod -R a+rx /usr/local/bin\n${presenceCheck}`;
  }
  const dockerfilePath = join(mkdtempSync(join(tmpdir(), "qm-sandbox-")), "Dockerfile");
  writeFileSync(dockerfilePath, dockerfileBody);
  return { sandboxDir, dockerfilePath, dockerfileBody, base, layer, binaries, hasCustom };
}

function runDocker(args: string[], failure: string): void {
  try {
    execFileSync("docker", args, { stdio: "inherit" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") die("docker not found — install Docker with Buildx.");
    throw new CliError(failure);
  }
}

function printBuild(prepared: PreparedBuild): void {
  note(`base:    ${prepared.hasCustom ? `${join(prepared.sandboxDir, "Dockerfile")} (custom)` : prepared.base}`);
  note(`context: ${prepared.sandboxDir}`);
  note(`tools:   ${prepared.binaries.length ? prepared.binaries.join(", ") : "(none)"}`);
}

export function runSandboxBuild(opts: SandboxBuildOpts): void {
  const prepared = prepare(opts);
  const tag = opts.tag ?? `${opts.config.orgId}-sandbox:local`;
  const args = [
    "buildx",
    "build",
    "--platform",
    SANDBOX_RUNTIME_PLATFORM,
    "--load",
    "-t",
    tag,
    "--file",
    prepared.dockerfilePath,
    prepared.sandboxDir,
  ];
  header(`qm sandbox build → ${tag}`);
  printBuild(prepared);
  if (opts.dryRun) {
    note(bold("\nDRY RUN — nothing built."));
    note(`\nDockerfile:\n${prepared.dockerfileBody}`);
    note(`docker ${args.join(" ")}`);
    return;
  }
  runDocker(args, "sandbox build failed — a declared tool binary may be missing from PATH.");
  ok(`built local image ${tag}`);
}

export function imageRepository(ref: string): string {
  const withoutDigest = ref.split("@")[0]!;
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

export const flySandboxRepository = (app: string): string => `registry.fly.io/${app}`;

function publishedRepository(opts: SandboxPublishOpts): string {
  if (opts.app) return opts.app.includes("/") ? imageRepository(opts.app) : flySandboxRepository(opts.app);
  const app = opts.config.sandbox?.app;
  if (app) return flySandboxRepository(app);
  if (opts.config.sandbox?.image) return imageRepository(opts.config.sandbox.image);
  die("sandbox publish needs sandbox.app in the QM deployment config or --app <registry/repository>.");
}

function authenticateFlyRegistry(opts: SandboxPublishOpts, references: string[]): void {
  const needsAuth = references
    .map(imageRepository)
    .some((repository) => repository === "registry.fly.io" || repository.startsWith("registry.fly.io/"));
  if (!needsAuth) return;
  const envPath = resolve(opts.envFile ?? join(dirname(opts.configPath), ".env"));
  if (opts.envFile && !existsSync(envPath)) throw new CliError(`--env-file not found: ${opts.envFile}`);
  const fileToken = existsSync(envPath) ? readEnvFile(envPath).get("FLY_SANDBOX_API_TOKEN") : undefined;
  const token = deploymentSecretValue("FLY_SANDBOX_API_TOKEN", fileToken);
  if (!token)
    throw new CliError(
      "Fly registry authentication requires FLY_SANDBOX_API_TOKEN in the deployment .env or process environment",
    );
  try {
    execFileSync(flyBin(), ["auth", "docker"], {
      stdio: "inherit",
      env: { ...process.env, FLY_API_TOKEN: token },
    });
  } catch {
    throw new CliError("Fly registry authentication failed — verify the app-scoped FLY_SANDBOX_API_TOKEN");
  }
}

function readDigest(metadataPath: string): string {
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  const digest = metadata["containerimage.digest"];
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new CliError("sandbox publish completed without an immutable image digest in Buildx metadata");
  }
  return digest;
}

export function pinnedByDigest(ref: string): string {
  let output: string;
  try {
    output = execFileSync("docker", ["buildx", "imagetools", "inspect", ref], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    const detail = stderr ? String(stderr).trim() : errMessage(error);
    if (/@sha256:[a-f0-9]{64}$/.test(ref)) {
      warn(
        `could not verify ${ref} against the registry${detail ? ` (${detail})` : ""}; proceeding with the digest-pinned ref — machines pull it with their own registry token`,
      );
      return ref;
    }
    throw new CliError(
      `could not resolve an immutable digest for ${ref} — the image may not exist, or the registry rejects reads with this token (Fly app-scoped deploy tokens cannot read the registry); pass ${imageRepository(ref)}@sha256:<digest> to skip the registry lookup${detail ? ` (${detail})` : ""}`,
    );
  }
  if (ref.includes("@sha256:")) return ref;
  const digest = output.match(/^Digest:\s*(sha256:[a-f0-9]{64})\s*$/m)?.[1];
  if (!digest) throw new CliError(`registry did not return an immutable digest for ${ref}`);
  return `${ref}@${digest}`;
}

function pinnedByPull(ref: string): string {
  runDocker(
    ["pull", "--platform", SANDBOX_RUNTIME_PLATFORM, ref],
    `could not pull ${ref} to resolve its immutable digest — pin the base by digest (${imageRepository(ref)}@sha256:<digest>, via --from or the sandbox/Dockerfile FROM) to skip resolution`,
  );
  let output: string;
  try {
    output = execFileSync("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", ref], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new CliError(`could not read the pulled image ${ref}: ${errMessage(error)}`);
  }
  const repository = imageRepository(ref);
  const digest = (JSON.parse(output) as string[]).find((entry) => entry.split("@")[0] === repository)?.split("@")[1];
  if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest))
    throw new CliError(`docker did not record an immutable digest for ${ref}`);
  return `${ref}@${digest}`;
}

export function recordSandboxPin(configPath: string, image: string | undefined, base?: string): void {
  const updates: Record<string, string> = {};
  if (image) updates["image"] = image;
  if (base?.includes("@sha256:")) updates["baseImage"] = base;
  if (!Object.keys(updates).length) return;
  writeFileSync(configPath, updateConfigSandbox(readFileSync(configPath, "utf8"), updates));
}

export function runSandboxPublish(opts: SandboxPublishOpts): { image: string } | undefined {
  let prepared = prepare(opts);
  assertPublishPlatform(prepared.dockerfileBody);
  const repository = publishedRepository(opts);
  if (!opts.dryRun) authenticateFlyRegistry(opts, [repository, prepared.base]);
  if (!opts.dryRun && prepared.base !== "scratch" && !prepared.base.includes("@sha256:")) {
    const base = pinnedByPull(prepared.base);
    if (prepared.hasCustom) {
      const dockerfileBody = replaceDockerfileBase(prepared.dockerfileBody, prepared.base, base);
      const dockerfilePath = join(mkdtempSync(join(tmpdir(), "qm-sandbox-")), "Dockerfile");
      writeFileSync(dockerfilePath, dockerfileBody);
      prepared = { ...prepared, base, dockerfileBody, dockerfilePath };
    } else {
      prepared = prepare({ ...opts, from: base });
    }
  }
  const tag = opts.tag ?? "latest";
  const tagged = `${repository}:${tag}`;
  const metadataPath = join(mkdtempSync(join(tmpdir(), "qm-sandbox-meta-")), "metadata.json");
  const args = [
    "buildx",
    "build",
    "--platform",
    SANDBOX_RUNTIME_PLATFORM,
    "--provenance=false",
    "--push",
    "-t",
    tagged,
    "--metadata-file",
    metadataPath,
    "--file",
    prepared.dockerfilePath,
    prepared.sandboxDir,
  ];
  header(`qm sandbox publish → ${tagged}`);
  printBuild(prepared);
  if (opts.dryRun) {
    note(bold("\nDRY RUN — nothing built, pushed, or recorded."));
    note(`\nDockerfile:\n${prepared.dockerfileBody}`);
    note(`docker ${args.join(" ")}`);
    return undefined;
  }
  runDocker(args, "sandbox publish failed — verify registry authentication and the layer build.");
  const digest = readDigest(metadataPath);
  const image = `${repository}@${digest}`;
  if (opts.config.target === "aws") {
    recordSandboxPin(opts.configPath, undefined, prepared.base);
    ok(`published ${image}`);
  } else {
    recordSandboxPin(opts.configPath, image, prepared.base);
    ok(`published and recorded ${image}`);
  }
  return { image };
}
