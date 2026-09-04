import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { killTree } from "./proc.ts";

function nodePids(): Array<{ pid: number; command: string }> {
  const res = spawnSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
  if (res.status !== 0) return [];
  return (res.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(" ");
      return { pid: Number(line.slice(0, space)), command: line.slice(space + 1) };
    })
    .filter((p) => Number.isFinite(p.pid) && /(^|\/)node(\s|$)/.test(p.command));
}

function processEnv(pid: number): string {
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8");
    } catch {
      return "";
    }
  }
  const res = spawnSync("ps", ["-Eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return res.status === 0 ? (res.stdout ?? "") : "";
}

function processCwd(pid: number): string {
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/cwd`, "utf8");
    } catch {
      return "";
    }
  }
  const res = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
  if (res.status !== 0) return "";
  const line = (res.stdout ?? "").split("\n").find((l) => l.startsWith("n"));
  return line ? line.slice(1) : "";
}

function envFileToken(cwd: string): string {
  try {
    const match = readFileSync(`${cwd}/.env`, "utf8").match(/^SLACK_APP_TOKEN=(.+)$/m);
    return match?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

export interface OrphanSweepResult {
  swept: Array<{ pid: number; command: string }>;
}

export async function sweepSlackTokenOrphans(
  appToken: string,
  ownedPids: Set<number>,
  log: (msg: string) => void,
): Promise<OrphanSweepResult> {
  const swept: Array<{ pid: number; command: string }> = [];
  if (!appToken) return { swept };
  for (const proc of nodePids()) {
    if (ownedPids.has(proc.pid) || proc.pid === process.pid) continue;
    let match = processEnv(proc.pid).includes(appToken);
    if (!match && proc.command.includes("src/index.ts")) {
      const cwd = processCwd(proc.pid);
      match = cwd.endsWith("/plugins/slack") && envFileToken(cwd) === appToken;
    }
    if (!match) continue;
    log(`killing orphaned process ${proc.pid} holding this slot's Slack app token: ${proc.command.slice(0, 120)}`);
    await killTree(proc.pid, 4000);
    swept.push(proc);
  }
  return { swept };
}
