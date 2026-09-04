import { spawn, type ChildProcess } from "node:child_process";
import { openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writePidFile } from "../lib/lease.ts";
import { freePort, tcpPortOpen, waitPortFree } from "../lib/proc.ts";
import { bestEffort, bestEffortValue, sleep } from "../lib/util.ts";
import type { ChildSpec, ChildState, ChildStatus } from "../lib/types.ts";

const READY_TIMEOUT_MS = Number(process.env.DEV_INSTANCE_READY_TIMEOUT || 40) * 1000;
const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
const CRASH_PARK_THRESHOLD = 5;
const HEALTHY_RESET_MS = 60_000;

export class Child {
  spec: ChildSpec;
  state: ChildState = "stopped";
  proc: ChildProcess | null = null;
  restarts = 0;
  consecutiveCrashes = 0;
  lastExit: ChildStatus["lastExit"] = null;
  lastReadyAt: number | null = null;
  lastSpawnAt = 0;
  private backoffMs = BACKOFF_START_MS;
  private stopRequested = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private logOffset = 0;

  private lockDir: string;
  private log: (msg: string) => void;
  private onCrash: (child: Child) => void;

  constructor(spec: ChildSpec, lockDir: string, log: (msg: string) => void, onCrash: (child: Child) => void) {
    this.spec = spec;
    this.lockDir = lockDir;
    this.log = log;
    this.onCrash = onCrash;
  }

  logFile(): string {
    return join(this.lockDir, `${this.spec.name}.log`);
  }

  update(spec: ChildSpec): void {
    this.spec = spec;
  }

  async start(): Promise<{ ok: boolean; detail?: string }> {
    this.stopRequested = false;
    if (this.spec.port) await freePort(this.spec.port, this.spec.name, this.log);
    this.state = "starting";
    this.lastSpawnAt = Date.now();
    const [cmd, ...rest] = this.spec.argv;
    if (!cmd) return { ok: false, detail: "empty argv" };
    this.logOffset = bestEffortValue(() => statSync(this.logFile()).size) ?? 0;
    const fd = openSync(this.logFile(), "a");
    const proc = spawn(cmd, rest, {
      cwd: this.spec.cwd,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: this.spec.env,
    });
    this.proc = proc;
    const pid = proc.pid;
    if (!pid) {
      this.state = "crashed";
      return { ok: false, detail: "spawn failed" };
    }
    if (this.stopRequested) {
      bestEffort(() => process.kill(-pid, "SIGKILL"));
      this.state = "stopped";
      return { ok: false, detail: "stopped during spawn" };
    }
    writePidFile(this.lockDir, `${this.spec.name}.pid`, pid);
    proc.on("exit", (code, signal) => this.handleExit(code, signal));

    const ready = await this.waitReady();
    if (!ready.ok) {
      this.state = "crashed";
      return ready;
    }
    this.state = "healthy";
    this.lastReadyAt = Date.now();
    return { ok: true };
  }

  private async waitReady(): Promise<{ ok: boolean; detail?: string }> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.state === "crashed" || (this.proc && this.proc.exitCode !== null)) {
        return { ok: false, detail: `${this.spec.name} exited during startup` };
      }
      if (this.spec.readiness.kind === "log") {
        const pattern = this.spec.readiness.pattern;
        const offset = this.logOffset;
        const seen = bestEffortValue(() => readFileSync(this.logFile(), "utf8").slice(offset).includes(pattern));
        if (seen) return { ok: true };
      } else {
        const url = this.spec.readiness.url;
        const ok = await fetch(url, { signal: AbortSignal.timeout(1000) })
          .then((res) => res.ok)
          .catch(() => false);
        if (ok) return { ok: true };
      }
      await sleep(500);
    }
    return { ok: false, detail: `${this.spec.name} not ready within ${READY_TIMEOUT_MS / 1000}s` };
  }

  private handleExit(code: number | null, signal: string | null): void {
    this.lastExit = { code, signal: signal ?? null, at: Date.now() };
    this.proc = null;
    if (this.stopRequested) {
      this.state = "stopped";
      return;
    }
    if (Date.now() - this.lastSpawnAt > HEALTHY_RESET_MS) {
      this.consecutiveCrashes = 0;
      this.backoffMs = BACKOFF_START_MS;
    }
    this.consecutiveCrashes += 1;
    this.state = "crashed";
    this.log(`${this.spec.name} exited (code=${code} signal=${signal})`);
    this.onCrash(this);
    if (this.consecutiveCrashes >= CRASH_PARK_THRESHOLD) {
      this.log(
        `${this.spec.name} crashed ${this.consecutiveCrashes}x in a row -- parking (dev restart ${this.spec.name} to retry)`,
      );
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_CAP_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopRequested) return;
      this.restarts += 1;
      void this.start().then((res) => {
        if (!res.ok) this.log(`${this.spec.name} restart failed: ${res.detail ?? "?"}`);
      });
    }, delay);
    this.restartTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.state = "stopping";
    const overallDeadline = Date.now() + this.spec.stopGraceMs + 15_000;
    while (this.proc && Date.now() < overallDeadline) {
      const pid = this.proc.pid;
      if (!pid) {
        await sleep(100);
        continue;
      }
      if (bestEffort(() => process.kill(-pid, "SIGTERM")) !== undefined) {
        bestEffort(() => process.kill(pid, "SIGTERM"));
      }
      const graceDeadline = Date.now() + this.spec.stopGraceMs;
      while (Date.now() < graceDeadline && this.proc?.pid === pid) await sleep(150);
      if (this.proc?.pid === pid) {
        bestEffort(() => process.kill(-pid, "SIGKILL"));
        const killDeadline = Date.now() + 3000;
        while (Date.now() < killDeadline && this.proc?.pid === pid) await sleep(100);
      }
    }
    if (this.spec.port) await waitPortFree(this.spec.port, 10_000);
    this.state = "stopped";
  }

  async restart(): Promise<{ ok: boolean; detail?: string }> {
    await this.stop();
    this.restarts += 1;
    this.consecutiveCrashes = 0;
    return await this.start();
  }

  async probeHealth(): Promise<boolean> {
    if (this.state !== "healthy" && this.state !== "unhealthy") return this.state === "starting";
    let ok: boolean;
    if (this.spec.health.kind === "tcp") {
      ok = await tcpPortOpen(this.spec.health.port);
    } else {
      try {
        const res = await fetch(this.spec.health.url, { signal: AbortSignal.timeout(2000) });
        ok = res.ok;
      } catch {
        ok = false;
      }
    }
    return ok;
  }

  status(): ChildStatus {
    return {
      state: this.state,
      pid: this.proc?.pid ?? null,
      port: this.spec.port,
      restarts: this.restarts,
      lastExit: this.lastExit,
      lastReadyAt: this.lastReadyAt,
    };
  }
}
