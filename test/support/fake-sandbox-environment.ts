import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

const SETSID = `#!/usr/bin/env python3
import os
import sys

args = sys.argv[1:]
if args and args[0] == "--wait":
    args = args[1:]
try:
    os.setsid()
except PermissionError:
    child = os.fork()
    if child:
        _, status = os.waitpid(child, 0)
        sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
    os.setsid()
os.execvp(args[0], args)
`;

export function createFakeSandboxEnvironment(root: string): () => NodeJS.ProcessEnv {
  if (process.platform !== "darwin") return () => ({ ...process.env, COPYFILE_DISABLE: "1" });
  const bin = join(root, ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "setsid"), SETSID, { mode: 0o755 });
  return () => ({ ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, COPYFILE_DISABLE: "1" });
}
