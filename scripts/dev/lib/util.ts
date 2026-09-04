import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

export function todayYmd(epoch = nowEpoch()): string {
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

export function formatAge(sec: number): string {
  if (sec < 0) sec = 0;
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(sec / 86400)}d${String(Math.floor((sec % 86400) / 3600)).padStart(2, "0")}h`;
}

export function fileMtimeEpoch(path: string): number {
  try {
    return Math.floor(statSync(path).mtimeMs / 1000);
  } catch {
    return nowEpoch();
  }
}

// Mirrors parseEnvLine in cli/src/util.ts — keep the two in agreement.
function parseEnvLine(raw: string): [key: string, value: string] | undefined {
  let line = raw.trim();
  if (!line || line.startsWith("#")) return undefined;
  if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();
  const eq = line.indexOf("=");
  if (eq <= 0) return undefined;
  const key = line.slice(0, eq).trim();
  let value = line.slice(eq + 1).trim();
  const quote = value[0];
  if (quote === '"' || quote === "'" || quote === "`") {
    const end = value.indexOf(quote, 1);
    if (end > 0) {
      value = value.slice(1, end);
      if (quote === '"') value = value.replaceAll("\\n", "\n");
    }
  }
  return [key, value];
}

export function readEnvFile(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const entry = parseEnvLine(line);
    if (entry && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0])) out[entry[0]] = entry[1];
  }
  return out;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function envSha(env: Record<string, string>): string {
  const lines = Object.keys(env)
    .sort()
    .map((k) => `${k}=${env[k]}`);
  return sha256Hex(lines.join("\n")).slice(0, 16);
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function bestEffort(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

export function bestEffortValue<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
