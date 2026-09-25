function stripHomePrefix(target: string): string {
  return target.replace(/^~\//, "").replace(/^~$/, "");
}

export function homeRelativePath(path: string): string {
  const rel = stripHomePrefix(path).replace(/^\.\//, "");
  if (!rel || rel.startsWith("/") || rel.split("/").includes("..") || rel.includes("\0")) {
    throw new Error(`file path must be home-relative: ${path}`);
  }
  return rel;
}
