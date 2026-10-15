import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withBrowserCleanup } from "./browser-errors.mjs";
let pending;
export function ensurePlaywright() {
  return (pending ??= load());
}
async function load() {
  const root = process.env.QM_BROWSE_CACHE || join(homedir(), ".cache", "qm-browse");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, `runtime-${process.pid}-`));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  process.once("exit", cleanup);
  try {
    for (const name of ["package.json", "package-lock.json"]) {
      await copyFile(new URL(`./runtime/${name}`, import.meta.url), join(dir, name));
      await chmod(join(dir, name), 0o600);
    }
    await promisify(execFile)(
      "npm",
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", join(root, "npm-cache")],
      {
        cwd: dir,
        env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1", npm_config_umask: "0077" },
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      },
    );
    return join(dir, "node_modules", "playwright-core", "index.mjs");
  } catch (error) {
    process.off("exit", cleanup);
    return withBrowserCleanup(
      () => {
        throw new Error(`Playwright runtime npm ci failed: ${error.stderr?.trim() || error.message}`, { cause: error });
      },
      () => rm(dir, { recursive: true, force: true }),
    );
  }
}
