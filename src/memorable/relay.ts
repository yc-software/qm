import { spawn } from "node:child_process";
import { worthOffering, type MemorableCapture } from "./capture.ts";

export const RELAY_TIMEOUT_MS = 120_000;

export function relayRecord(
  bin: string,
  capture: MemorableCapture,
  timeoutMs: number = RELAY_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve) => {
    const workflows = capture.workflows.filter(worthOffering);
    if (!workflows.length) {
      resolve();
      return;
    }
    const [cmd = "memorable", ...preArgs] = bin.split(" ").filter(Boolean);
    const child = spawn(cmd, [...preArgs, "record", "--scope", capture.scope_id], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.unref();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, timeoutMs);
    timer.unref();
    child.on("error", finish);
    child.on("exit", finish);
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ ...capture, workflows }));
  });
}
