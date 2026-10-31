import { spawnSync } from "node:child_process";
import { CliError, errMessage } from "../log.ts";
import { capture, flyBin } from "../util.ts";

export const FLY_APP_NOT_FOUND = /could not find app|app not found/i;

export function fly(args: string[], opts: { allow?: RegExp } = {}): string {
  try {
    return capture(flyBin(), args, opts);
  } catch (e) {
    throw new CliError(errMessage(e));
  }
}

export function stageSecret(app: string, name: string, value: string): void {
  const result = spawnSync(flyBin(), ["secrets", "set", "--stage", "-a", app, `${name}=-`], {
    input: value,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) throw new CliError(`failed to stage ${name} on ${app}`);
}

export function flySensitive(args: string[], failure: string): string {
  const result = spawnSync(flyBin(), args, { encoding: "utf8" });
  if (result.status !== 0) throw new CliError(failure);
  return result.stdout;
}

export function secretNames(app: string): Set<string> | undefined {
  const out = fly(["secrets", "list", "-a", app], { allow: FLY_APP_NOT_FOUND });
  if (FLY_APP_NOT_FOUND.test(out)) return undefined;
  return new Set(
    [...out.matchAll(/^\s*\*?\s*([A-Z0-9_]+)\s/gm)].map((m) => m[1]).filter((s): s is string => s !== undefined),
  );
}
