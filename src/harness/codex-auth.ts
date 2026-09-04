import { randomBytes } from "node:crypto";
import { open as openFile } from "node:fs/promises";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { swallow } from "../util/errors.ts";
import type { JsonObject } from "./codex-auth-file.ts";

export { codexAuthFileForEnv, readCodexOAuthAuthFile } from "./codex-auth-file.ts";

const heldOAuthLockPaths = new Set<string>();

function writeJsonAtomically(path: string, value: JsonObject): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.qm-codex-auth-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Atomically replace a Codex auth.json with 0600 permissions. */
export function writeCodexOAuthAuthFile(path: string, auth: JsonObject): void {
  writeJsonAtomically(path, auth);
}

function lockPath(sourcePath: string): string {
  return `${sourcePath}.lock`;
}

export interface CodexOAuthAuthLock {
  path: string;
  isHeld(): boolean;
  release(): Promise<void>;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code !== "ESRCH");
  }
}

function removeStaleLock(path: string): boolean {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
    const owner = Number(contents.trim().split(":", 1)[0]);
    if (Number.isInteger(owner) && owner > 0) {
      if (owner === process.pid && heldOAuthLockPaths.has(path)) return false;
      if (owner === process.pid) {
        if (Date.now() - statSync(path).mtimeMs <= 60_000) return false;
      } else if (processAlive(owner)) return false;
    } else if (Date.now() - statSync(path).mtimeMs <= 60_000) return false;
  } catch {
    return true;
  }
  const detached = `${path}.stale-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    renameSync(path, detached);
  } catch {
    return true;
  }
  try {
    if (readFileSync(detached, "utf8") !== contents) {
      if (!existsSync(path)) renameSync(detached, path);
      return false;
    }
    unlinkSync(detached);
    return true;
  } catch {
    if (!existsSync(path)) {
      try {
        renameSync(detached, path);
      } catch (error) {
        swallow("codex: stale lock restore", error);
      }
    }
    return true;
  }
}

export async function acquireCodexOAuthAuthLock(
  sourcePath: string,
  signal?: AbortSignal,
  timeoutMs = 120_000,
  pollMs = 100,
): Promise<CodexOAuthAuthLock> {
  const path = lockPath(sourcePath);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Codex OAuth auth lock acquisition cancelled");
    try {
      const handle = await openFile(path, "wx", 0o600);
      const owner = `${process.pid}:${randomBytes(8).toString("hex")}`;
      try {
        await handle.writeFile(owner);
        heldOAuthLockPaths.add(path);
      } catch (error) {
        await handle.close().catch(() => undefined);
        try {
          unlinkSync(path);
        } catch (cleanupError) {
          swallow("codex: oauth lock creation cleanup", cleanupError);
        }
        throw error;
      }
      let released = false;
      return {
        path,
        isHeld() {
          if (released) return false;
          try {
            return readFileSync(path, "utf8") === owner;
          } catch {
            return false;
          }
        },
        async release() {
          if (released) return;
          released = true;
          await handle.close().catch(() => undefined);
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              if (readFileSync(path, "utf8") !== owner) {
                heldOAuthLockPaths.delete(path);
                return;
              }
              unlinkSync(path);
              heldOAuthLockPaths.delete(path);
              return;
            } catch (error) {
              if (attempt === 2) {
                heldOAuthLockPaths.delete(path);
                throw error;
              } else await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
            }
          }
        },
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") throw error;
      removeStaleLock(path);
      await new Promise<void>((resolveWait) => {
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolveWait();
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolveWait();
        }, pollMs);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
  throw new Error("timed out acquiring the Codex OAuth auth lock");
}
