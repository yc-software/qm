import { chmodSync, mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SupervisorSocketLocation {
  path: string;
  tempDir?: string;
}

export function supervisorSocketLocation(lock: string, slot: string, tempRoot = "/tmp"): SupervisorSocketLocation {
  const direct = join(lock, "supervisor.sock");
  if (direct.length <= 100) return { path: direct };
  const tempDir = mkdtempSync(join(tempRoot, `qm-dev-${slot}-`));
  chmodSync(tempDir, 0o700);
  if ((statSync(tempDir).mode & 0o777) !== 0o700) throw new Error("supervisor socket directory is not private");
  return { path: join(tempDir, "supervisor.sock"), tempDir };
}

export function restrictSupervisorSocket(path: string): void {
  chmodSync(path, 0o600);
  if ((statSync(path).mode & 0o777) !== 0o600) throw new Error("supervisor socket is not private");
}
