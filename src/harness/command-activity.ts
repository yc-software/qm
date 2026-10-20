import { plainArgv } from "../policy/command-policy.ts";

export type CommandActivity =
  | { kind: "read"; path: string }
  | { kind: "list_files"; path?: string }
  | { kind: "search"; pattern: string; path?: string };

const SEARCH_FLAGS = new Set([
  "-n",
  "--line-number",
  "-i",
  "--ignore-case",
  "-l",
  "--files-with-matches",
  "-F",
  "--fixed-strings",
  "-w",
  "--word-regexp",
  "--hidden",
]);

const isOption = (arg: string | undefined): boolean => arg?.startsWith("-") === true;

function isLineRange(arg: string): boolean {
  if (!arg.endsWith("p")) return false;
  const bounds = arg.slice(0, -1).split(",");
  return bounds.length <= 2 && bounds.every((bound) => bound !== "" && Number.isSafeInteger(Number(bound)));
}

export function commandActivity(command: string): CommandActivity | undefined {
  const argv = plainArgv(command);
  if (!argv) return undefined;
  const [name, ...args] = argv;
  if (name === "cat" && args.length === 1 && !isOption(args[0])) return { kind: "read", path: args[0]! };
  if (name === "sed" && args.length === 3 && args[0] === "-n" && isLineRange(args[1]!) && !isOption(args[2]))
    return { kind: "read", path: args[2]! };
  if (name === "rg" && args[0] === "--files" && args.length <= 2 && !isOption(args[1]))
    return { kind: "list_files", ...(args[1] ? { path: args[1] } : {}) };
  if (name !== "rg" && name !== "grep") return undefined;
  let first = 0;
  while (SEARCH_FLAGS.has(args[first] ?? "")) first++;
  const rest = args.slice(first);
  if (rest.length < 1 || rest.length > 2 || rest.some(isOption)) return undefined;
  return { kind: "search", pattern: rest[0]!, ...(rest[1] ? { path: rest[1] } : {}) };
}
