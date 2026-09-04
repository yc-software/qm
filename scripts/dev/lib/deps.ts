import { existsSync } from "node:fs";
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

export async function ensureDeps(
  worktree: string,
  opts: { watch: boolean; webUiBasePath: string },
  log: (msg: string) => void,
): Promise<void> {
  if (!existsSync(join(worktree, "node_modules/emoji-datasource"))) await npmInstall(worktree, "core", log);
  if (!existsSync(join(worktree, "plugins/web-ui/node_modules/vite")))
    await npmInstall(join(worktree, "plugins/web-ui"), "web-ui plugin", log);
  if (!opts.watch) {
    log(`building web-ui SPA (vite, base=${opts.webUiBasePath})...`);
    const res = await run("npm", ["run", "build"], {
      cwd: join(worktree, "plugins/web-ui"),
      env: { ...process.env, WEB_UI_BASE: opts.webUiBasePath },
      timeoutMs: 600_000,
    });
    if (res.code !== 0) {
      throw new Error(`web-ui build failed: ${(res.stderr || res.stdout || "").split("\n").slice(-8).join("\n")}`);
    }
  }
}
