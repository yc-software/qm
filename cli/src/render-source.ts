import { spawnSync } from "node:child_process";

export function githubRepoUrl(value: string): string | undefined {
  const url = URL.parse(value.trim());
  if (!url || url.protocol !== "https:" || url.host !== "github.com") return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  const segments = url.pathname
    .replace(/\/$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .slice(1);
  if (segments.length !== 2 || !segments.every((segment) => /^[A-Za-z0-9_.-]+$/.test(segment))) return undefined;
  return `https://github.com/${segments.join("/")}`;
}

export function isGitBranchName(branch: string): boolean {
  return spawnSync("git", ["check-ref-format", "--branch", branch], { stdio: "ignore" }).status === 0;
}
