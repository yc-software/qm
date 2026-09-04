import { request } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readState } from "./lease.ts";
import { bestEffort, sleep } from "./util.ts";
import type { BootPhaseEvent } from "./types.ts";

export function resolveSocketPath(lock: string): string {
  const state = readState(lock);
  if (state && typeof state.socketPath === "string") return state.socketPath;
  return join(lock, "supervisor.sock");
}

export function supervisorRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 120_000,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, method, path, timeout: timeoutMs, headers: { "content-type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: { raw: data } });
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("supervisor request timed out"));
    });
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

export async function supervisorReachable(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  try {
    const res = await supervisorRequest(socketPath, "GET", "/status", undefined, 3000);
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function waitForSupervisor(socketPath: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await supervisorReachable(socketPath)) return true;
    await sleep(300);
  }
  return false;
}

export function streamBootEvents(socketPath: string, onEvent: (e: BootPhaseEvent) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method: "GET", path: "/boot-events" }, (res) => {
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          bestEffort(() => onEvent(JSON.parse(line) as BootPhaseEvent));
        }
      });
      res.on("end", () => resolve());
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}
