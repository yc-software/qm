import { spawn } from "node:child_process";
import { worthOffering, type MemorableCapture } from "./capture.ts";

const RELAY_TIMEOUT_MS = 120_000;
const MAX_RELAY_STDOUT = 8_192;
const MAX_RELAY_STDERR = 2_048;

function refusalReason(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(text) as { error?: unknown; mode?: unknown };
      if (typeof parsed.error === "string") {
        return typeof parsed.mode === "string" ? `${parsed.error} (consent ${parsed.mode})` : parsed.error;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export type RelayOutcome = { ok: true } | { ok: false; reason: string };

export function relayRecord(
  bin: string,
  capture: MemorableCapture,
  timeoutMs: number = RELAY_TIMEOUT_MS,
  opts?: { env: NodeJS.ProcessEnv; apiKey?: string },
): Promise<RelayOutcome> {
  return new Promise((resolve) => {
    const workflows = capture.workflows.filter(worthOffering);
    if (!workflows.length) {
      resolve({ ok: true });
      return;
    }
    const [cmd = "memorable", ...preArgs] = bin.split(" ").filter(Boolean);
    const child = spawn(cmd, [...preArgs, "record", "--scope", capture.scope_id, "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(opts ? { env: { ...opts.env, ...(opts.apiKey ? { MEMORABLE_API_KEY: opts.apiKey } : {}) } } : {}),
    });
    child.unref();
    let settled = false;
    let out = "";
    let err = "";
    const finish = (outcome: RelayOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, reason: "timeout" });
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (c: Buffer) => {
      if (out.length < MAX_RELAY_STDOUT) out += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      if (err.length < MAX_RELAY_STDERR) err += c.toString("utf8");
    });
    child.on("error", (e) => finish({ ok: false, reason: e.message.slice(0, 200) }));
    child.on("exit", (code) => {
      if (code === 0) return finish({ ok: true });
      const detail = err.replace(/\s+/g, " ").trim().slice(0, 300);
      finish({ ok: false, reason: refusalReason(out) ?? (detail ? `exit ${code}: ${detail}` : `exit ${code}`) });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ ...capture, workflows }));
  });
}
