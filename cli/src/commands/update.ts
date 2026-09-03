import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CliError, errMessage, note, ok } from "../log.ts";
import { cliPackageName } from "../manifest.ts";
import type { Target } from "../providers.ts";
import { capture, runInherit } from "../util.ts";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const RELEASE_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

function versionParts(version: string): [number, number, number, string | undefined] | null {
  const match = SEMVER.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4]];
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) throw new CliError(`invalid QM version: ${!left ? a : b}`);
  for (const i of [0, 1, 2] as const) {
    const difference = left[i]! - right[i]!;
    if (difference !== 0) return Math.sign(difference);
  }
  if (left[3] === right[3]) return 0;
  if (left[3] === undefined) return 1;
  if (right[3] === undefined) return -1;
  return left[3].localeCompare(right[3], undefined, { numeric: true });
}

function pinnedVersion(dir: string, packageName: string): string {
  const path = join(dir, "package.json");
  if (!existsSync(path)) throw new CliError(`update requires ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CliError(`${path} is not valid JSON`, { cause: error });
  }
  const dependency =
    parsed && typeof parsed === "object" && "dependencies" in parsed
      ? (parsed as { dependencies?: Record<string, unknown> }).dependencies?.[packageName]
      : undefined;
  if (typeof dependency !== "string" || !versionParts(dependency)) {
    throw new CliError(`${path} must pin ${packageName} to an exact version before it can be updated`);
  }
  return dependency;
}

interface RegistryMetadata {
  time?: Record<string, unknown>;
  versions?: unknown;
  "dist-tags"?: { latest?: unknown };
}

function releaseMetadata(dir: string, packageName: string, npm: string): RegistryMetadata {
  let raw: string;
  try {
    raw = capture(npm, ["view", packageName, "time", "versions", "dist-tags", "--json"], { cwd: dir }).trim();
  } catch (error) {
    throw new CliError(errMessage(error), { cause: error });
  }
  try {
    return JSON.parse(raw) as RegistryMetadata;
  } catch (error) {
    throw new CliError("npm returned invalid QM release metadata", { cause: error });
  }
}

function eligibleVersions(metadata: RegistryMetadata, now: number): string[] {
  const newest = metadata["dist-tags"]?.latest;
  if (typeof newest !== "string" || !versionParts(newest)) {
    throw new CliError(`npm returned an invalid latest QM version: ${JSON.stringify(newest)}`);
  }
  const versions = Array.isArray(metadata.versions) ? metadata.versions : [];
  return versions
    .filter((version): version is string => {
      const parts = typeof version === "string" ? versionParts(version) : null;
      const published = typeof version === "string" ? metadata.time?.[version] : undefined;
      const parsed = typeof published === "string" ? Date.parse(published) : NaN;
      return (
        parts?.[3] === undefined &&
        Number.isFinite(parsed) &&
        parsed <= now - RELEASE_AGE_MS &&
        compareVersions(version, newest) <= 0
      );
    })
    .sort(compareVersions);
}

function targetVersion(metadata: RegistryMetadata, requested: string | undefined, now: number): string {
  const eligible = eligibleVersions(metadata, now);
  const latest = eligible.at(-1);
  if (!latest) throw new CliError("npm has no QM release outside the seven-day dependency cooldown");
  if (!requested) return latest;
  if (!versionParts(requested) || !eligible.includes(requested)) {
    throw new CliError(`QM ${requested} is not an eligible stable release outside the seven-day dependency cooldown`);
  }
  return requested;
}

function runNpm(npm: string, args: string[], dir: string, operation: string): void {
  try {
    runInherit(npm, args, { cwd: dir });
  } catch (error) {
    throw new CliError(`${operation} failed`, { cause: error });
  }
}

export function runUpdate(options: {
  configDir: string;
  configPath: string;
  sandboxDir: string;
  envFile?: string;
  target: Target;
  yes: boolean;
  version?: string;
  now?: number;
}): void {
  const packageName = cliPackageName();
  const npm = process.env.NPM_BIN ?? "npm";
  const current = pinnedVersion(options.configDir, packageName);
  const latest = targetVersion(
    releaseMetadata(options.configDir, packageName, npm),
    options.version,
    options.now ?? Date.now(),
  );
  if (options.version && compareVersions(current, latest) > 0) {
    throw new CliError(`QM ${latest} is older than the deployment's current ${current} pin`);
  }
  const updateAvailable = compareVersions(current, latest) < 0;

  if (!updateAvailable && !options.yes) {
    ok(`QM ${current} is already current`);
    return;
  }
  if (!options.yes) {
    note(`QM ${current} → ${latest}`);
    note("Run `npm exec qm -- update --yes` to install and deploy it.");
    return;
  }

  if (updateAvailable) {
    note(`QM ${current} → ${latest}`);
    runNpm(npm, ["install", "--save-exact", `${packageName}@${latest}`], options.configDir, "QM package update");
    ok(`pinned ${packageName}@${latest}`);
  } else {
    note(`QM ${current} is already pinned; reconciling the deployment`);
  }

  runNpm(
    npm,
    [
      "exec",
      "qm",
      "--",
      "up",
      "--config",
      options.configPath,
      "--sandbox-dir",
      options.sandboxDir,
      ...(options.envFile ? ["--env-file", options.envFile] : []),
      ...(options.target === "aws" ? ["--yes"] : []),
    ],
    options.configDir,
    "QM deployment",
  );
  ok(`QM ${updateAvailable ? latest : current} deployed`);
}
