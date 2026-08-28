import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BoxdError, ConflictError, NotFoundError, RateLimitError } from "@boxd-sh/sdk";
import type { BoxdClientLike, BoxdMachine } from "../../src/sandbox/boxd-sandbox.ts";

const GRPC_MAX_MESSAGE = 4 * 1024 * 1024;

interface FakeMachine {
  id: string;
  name: string;
  status: string;
  org: string | null;
  config: Record<string, unknown> | null;
  home: string;
}

export interface FakeBoxd {
  client: BoxdClientLike;
  homeDir(name: string): string;
  names(): string[];
  machine(
    name: string,
  ): { id: string; status: string; org: string | null; config: Record<string, unknown> | null } | null;
  stop(name: string): void;
  destroy(name: string): void;
  execScripts(): string[];
  stallAfterRun(name: string): void;
  fail(name: string): void;
  refuseReboot(name: string): void;
  reboots(): string[];
  listCalls(): Array<{ org?: string }>;
  cleanup(): void;
}

export const FAKE_BOXD_API_KEY = "bxd_test";

export function installFakeBoxd(): FakeBoxd {
  const root = mkdtempSync(join(tmpdir(), "fake-boxd-"));
  const machines = new Map<string, FakeMachine>();
  const execScripts: string[] = [];
  const listCalls: Array<{ org?: string }> = [];
  const stallAfterRun = new Set<string>();
  const failing = new Set<string>();
  const refusedReboot = new Set<string>();
  const reboots: string[] = [];
  let nextId = 1;

  const live = (name: string): FakeMachine | undefined =>
    [...machines.values()].find((m) => m.name === name && m.status !== "destroyed");

  const byId = (id: string): FakeMachine => {
    const m = machines.get(id);
    if (!m) throw new NotFoundError("VM not found", 5);
    return m;
  };

  const running = (id: string): FakeMachine => {
    const m = byId(id);
    if (m.status === "destroyed") throw new NotFoundError("VM is destroyed", 5);
    if (m.status === "stopped" || m.status === "failed") {
      throw new ConflictError(
        `VM ${m.name} is stopped and can't be resumed automatically — start it from the Machines page`,
        9,
      );
    }
    if (m.status === "starting") m.status = "running";
    if (m.status === "suspended" || m.status === "hibernated") m.status = "running";
    return m;
  };

  const record = (m: FakeMachine): BoxdMachine => ({ id: m.id, name: m.name, status: m.status });

  const remap = (m: FakeMachine, script: string): string => {
    const homeRe = m.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const remapPath = new RegExp(`${homeRe}/tmp/|${homeRe}(?![A-Za-z0-9._-])|/tmp/`, "g");
    return (
      `export HOME=${JSON.stringify(m.home)}; ` +
      script
        .replace(/^timeout \d+ sh -c /, "sh -c ")
        .replace(/\btimeout \d+ /g, "")
        .replace(/\/home\/boxd/g, m.home)
        .replace(remapPath, (mm) => (mm.startsWith(m.home) ? mm : `${m.home}/tmp/`))
    );
  };

  const hostPath = (m: FakeMachine, abs: string): string => {
    if (abs.startsWith("/tmp/")) return join(m.home, "tmp", abs.slice(5));
    return abs.replace(/^\/home\/boxd/, m.home);
  };

  const runExec = (m: FakeMachine, command: string): { stdout: string; stderr: string; exitCode: number } => {
    execScripts.push(command);
    mkdirSync(join(m.home, "tmp"), { recursive: true });
    const r = spawnSync("sh", ["-c", remap(m, command)], {
      encoding: "buffer",
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    return {
      stdout: (r.stdout ?? Buffer.alloc(0)).toString("utf8"),
      stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8"),
      exitCode: r.status ?? (r.signal ? 137 : -1),
    };
  };

  const client: BoxdClientLike = {
    machines: {
      async create(params) {
        if (live(params.name)) throw new ConflictError(`name '${params.name}' is already taken`, 9);
        const id = `vm-${nextId++}`;
        const m: FakeMachine = {
          id,
          name: params.name,
          status: "running",
          org: params.org ?? null,
          config: params.config ?? null,
          home: join(root, id),
        };
        mkdirSync(m.home, { recursive: true });
        machines.set(id, m);
        return record(m);
      },
      async get(id) {
        const m = byId(id);
        if (m.status === "starting") m.status = "running";
        return record(m);
      },
      async list(params = {}) {
        listCalls.push(params);
        return [...machines.values()]
          .filter((m) => m.status !== "destroyed" && (!params.org || m.org === params.org))
          .map(record);
      },
      async delete(id) {
        const m = byId(id);
        m.status = "destroyed";
        rmSync(m.home, { recursive: true, force: true });
      },
      async start(id) {
        const m = byId(id);
        if (m.status === "stopped" || m.status === "failed") m.status = "starting";
      },
      async reboot(id) {
        const m = byId(id);
        if (refusedReboot.has(m.name)) throw new BoxdError("upstream reboot failed", 13);
        reboots.push(m.name);
        failing.delete(m.name);
        m.status = "starting";
      },
      async exec(id, params) {
        const m = running(id);
        if (failing.has(m.name)) throw new BoxdError("cannot connect to VM agent: connection refused", 14);
        const r = runExec(m, params.command);
        if (stallAfterRun.has(m.name)) {
          stallAfterRun.delete(m.name);
          throw new BoxdError(`exec timed out after ${params.timeout ?? 0}ms`);
        }
        return r;
      },
      files: {
        async upload(id, path, data) {
          const m = running(id);
          const target = hostPath(m, path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, data);
          return data.length;
        },
        async download(id, path) {
          const m = running(id);
          const target = hostPath(m, path);
          if (!existsSync(target))
            throw new NotFoundError(`stat: cannot statx '${path}': No such file or directory`, 5);
          const data = readFileSync(target);
          if (data.length + 5 > GRPC_MAX_MESSAGE) {
            throw new RateLimitError(`Received message larger than max (${data.length + 5} vs ${GRPC_MAX_MESSAGE})`, 8);
          }
          return new Uint8Array(data);
        },
      },
    },
  };

  return {
    client,
    homeDir: (name) => {
      const m = live(name);
      if (!m) throw new Error(`fake boxd: no live machine named ${name}`);
      return m.home;
    },
    names: () => [...machines.values()].filter((m) => m.status !== "destroyed").map((m) => m.name),
    machine: (name) => {
      const m = live(name);
      return m ? { id: m.id, status: m.status, org: m.org, config: m.config } : null;
    },
    stop: (name) => {
      const m = live(name);
      if (m) m.status = "stopped";
    },
    destroy: (name) => {
      const m = live(name);
      if (m) {
        m.status = "destroyed";
        rmSync(m.home, { recursive: true, force: true });
      }
    },
    execScripts: () => [...execScripts],
    stallAfterRun: (name) => {
      stallAfterRun.add(name);
    },
    fail: (name) => {
      failing.add(name);
    },
    refuseReboot: (name) => {
      refusedReboot.add(name);
    },
    reboots: () => [...reboots],
    listCalls: () => [...listCalls],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
