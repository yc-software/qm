import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { run } from "./proc.ts";

async function npmInstall(dir: string, logLabel: string, log: (msg: string) => void): Promise<void> {
  log(`installing ${logLabel} deps (first run in this worktree, may take a minute)...`);
  const res = await run("npm", ["install"], { cwd: dir, timeoutMs: 600_000 });
  if (res.code !== 0) {
    throw new Error(
      `npm install failed in ${dir}: ${(res.stderr || res.stdout || "").split("\n").slice(-8).join("\n")}`,
    );
  }
}

export function webUiSourceHash(worktree: string, basePath: string): string {
  const listed = spawnSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "plugins/web-ui",
      "plugins/chassis",
      "package-lock.json",
    ],
    { cwd: worktree, encoding: "utf8" },
  );
  if (listed.status !== 0) throw new Error(`git ls-files failed in ${worktree}: ${listed.stderr || listed.error}`);
  const files = listed.stdout.split("\0");
  const hash = createHash("sha256").update(basePath);
  for (const file of files.filter((f) => f && existsSync(join(worktree, f))).sort()) {
    hash.update(`\0${file}\0`).update(readFileSync(join(worktree, file)));
  }
  return hash.digest("hex");
}

export async function ensureDeps(
  worktree: string,
  opts: { web?: boolean; webUiBasePath: string },
  log: (msg: string) => void,
): Promise<void> {
  const web = join(worktree, "plugins/web-ui");
  await Promise.all([
    existsSync(join(worktree, "node_modules/emoji-datasource")) ? null : npmInstall(worktree, "core", log),
    opts.web === false || existsSync(join(web, "node_modules/vite")) ? null : npmInstall(web, "web-ui plugin", log),
  ]);
  if (opts.web === false) return;
  const stamp = join(web, "dist-web/.source-hash");
  const sourceHash = webUiSourceHash(worktree, opts.webUiBasePath);
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === sourceHash) {
    log("web-ui SPA unchanged since the last build -- skipping vite");
    return;
  }
  log(`building web-ui SPA (vite, base=${opts.webUiBasePath})...`);
  const res = await run("npm", ["run", "build"], {
    cwd: web,
    env: { ...process.env, WEB_UI_BASE: opts.webUiBasePath },
    timeoutMs: 600_000,
  });
  if (res.code !== 0) {
    throw new Error(`web-ui build failed: ${(res.stderr || res.stdout || "").split("\n").slice(-8).join("\n")}`);
  }
  writeFileSync(stamp, sourceHash);
}
