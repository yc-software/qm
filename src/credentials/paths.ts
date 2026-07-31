function stripHomePrefix(target: string): string {
  return target.replace(/^~\//, "").replace(/^~$/, "");
}

const SHELL_UNSAFE_CHARS = /["'`$\\\x00-\x1f]/;

export function homeRelativePath(path: string): string {
  const rel = stripHomePrefix(path).replace(/^\.\//, "");
  if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) {
    throw new Error(`file path must be home-relative: ${path}`);
  }
  if (SHELL_UNSAFE_CHARS.test(rel)) {
    throw new Error(`file path contains shell-unsafe characters: ${path}`);
  }
  return rel;
}
