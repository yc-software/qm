import { spawn } from "node:child_process";
import type { MemorableCapture } from "./capture.ts";

export function relayRecord(bin: string, capture: MemorableCapture): Promise<void> {
  return new Promise((resolve) => {
    const [cmd = "memorable", ...preArgs] = bin.split(" ").filter(Boolean);
    const child = spawn(cmd, [...preArgs, "record", "--scope", capture.scope_id], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.unref();
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(capture));
  });
}
