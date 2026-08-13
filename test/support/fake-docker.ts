import type { DockerExec } from "../../src/sandbox/local-sandbox.ts";

export interface FakeContainer {
  name: string;
  imageId: string;
  running: boolean;
  labels: Record<string, string>;
  volume?: string;
}

export interface FakeDocker {
  dockerExec: DockerExec;
  containers: Map<string, FakeContainer>;
  volumes: Set<string>;
  networks: Set<string>;
  networkLabels: Map<string, Record<string, string>>;
  networkMembers: Map<string, Set<string>>;
  runCount: number;
  daemonDown: boolean;
  imageMissing: boolean;
  imageId: string;
  imageFingerprint: string;
  commands: string[][];
  migratedVolumes: Set<string>;
  volumeLabels: Map<string, Record<string, string>>;
  failRun: boolean;
  conflictOnRun: boolean;
  failStop: boolean;
}

export function installFakeDocker(daemonPort: number): FakeDocker {
  const containers = new Map<string, FakeContainer>();
  const volumes = new Set<string>();
  const networks = new Set<string>();
  const networkMembers = new Map<string, Set<string>>();
  const networkLabels = new Map<string, Record<string, string>>();
  const migratedVolumes = new Set<string>();
  const volumeLabels = new Map<string, Record<string, string>>();
  const self: FakeDocker = {
    containers,
    volumes,
    networks,
    networkLabels,
    networkMembers,
    runCount: 0,
    daemonDown: false,
    imageMissing: false,
    imageId: "sha256:image-v1",
    imageFingerprint: "",
    commands: [],
    migratedVolumes,
    volumeLabels,
    failRun: false,
    conflictOnRun: false,
    failStop: false,
    dockerExec: async (args) => exec(args),
  };

  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });

  function parseRun(args: string[]): FakeContainer {
    const c: FakeContainer = { name: "", imageId: self.imageId, running: true, labels: {} };
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--name") c.name = args[++i]!;
      else if (a === "--label") {
        const [k = "", v = ""] = args[++i]!.split("=");
        c.labels[k] = v;
      } else if (a === "-v") c.volume = args[++i]!.split(":")[0]!;
      else if (a === "-p" || a === "--cpus" || a === "--memory") i++;
    }
    return c;
  }

  function exec(args: string[]): { code: number; stdout: string; stderr: string } {
    self.commands.push(args);
    const [cmd, ...rest] = args;
    if (self.daemonDown) return fail("Cannot connect to the Docker daemon");
    switch (cmd) {
      case "version":
        return ok("Docker version fake");
      case "image": {
        if (self.imageMissing) return fail("Error: No such image");
        return ok(`${self.imageId} ${self.imageFingerprint}`);
      }
      case "inspect": {
        const name = rest[rest.length - 1]!;
        const c = containers.get(name);
        if (!c) return fail(`Error: No such object: ${name}`);
        const format = rest[rest.indexOf("-f") + 1] ?? "";
        if (format.includes(".Mounts")) return ok(c.volume ?? "");
        if (format.includes("qm.volume-owner")) {
          return ok(
            `${c.running} ${c.labels["qm.volume-owner"] ?? ""} ${c.labels["qm.volume-org"] ?? ""} ${c.labels["qm.scope"] ?? ""}`,
          );
        }
        return ok(
          `${c.running} ${c.imageId} ${c.labels["qm.org"] ?? ""} ${c.labels["qm.scope"] ?? ""} ${c.labels["qm.provision"] ?? ""}`,
        );
      }
      case "network": {
        const [sub] = rest;
        const name = rest[rest.length - 1]!;
        if (sub === "inspect") {
          if (!networks.has(name)) return fail(`Error: No such network: ${name}`);
          const format = rest[rest.indexOf("-f") + 1] ?? "";
          const label = format.match(/\.Labels "([^"]+)"/)?.[1];
          return ok(label ? (networkLabels.get(name)?.[label] ?? "") : name);
        }
        if (sub === "create") {
          if (networks.has(name)) return fail(`network with name ${name} already exists`);
          networks.add(name);
          networkMembers.set(name, new Set());
          const labels: Record<string, string> = {};
          for (let i = 0; i < rest.length; i++) {
            if (rest[i] !== "--label") continue;
            const [key = "", value = ""] = rest[++i]!.split("=");
            labels[key] = value;
          }
          networkLabels.set(name, labels);
          return ok(name);
        }
        if (sub === "connect") {
          const network = rest[rest.length - 2]!;
          const member = rest[rest.length - 1]!;
          const members = networkMembers.get(network);
          if (!members) return fail(`Error: No such network: ${network}`);
          if (members.has(member)) return fail(`endpoint already exists in network ${network}`);
          members.add(member);
          return ok();
        }
        if (sub === "disconnect") {
          const network = rest[rest.length - 2]!;
          const member = rest[rest.length - 1]!;
          const members = networkMembers.get(network);
          if (!members) return fail(`Error: No such network: ${network}`);
          members.delete(member);
          return ok();
        }
        if (sub === "rm") {
          if (!networks.has(name)) return fail(`Error: No such network: ${name}`);
          if (networkMembers.get(name)?.size) return fail(`network ${name} has active endpoints`);
          networks.delete(name);
          networkMembers.delete(name);
          networkLabels.delete(name);
          return ok(name);
        }
        return fail(`unknown network subcommand ${sub}`);
      }
      case "volume": {
        const [sub] = rest;
        const name = rest[rest.length - 1]!;
        if (sub === "inspect") {
          if (!volumes.has(name)) return fail(`Error: no such volume: ${name}`);
          const format = rest[rest.indexOf("-f") + 1] ?? "";
          const label = format.match(/\.Labels "([^"]+)"/)?.[1];
          return ok(label ? (volumeLabels.get(name)?.[label] ?? "") : name);
        }
        if (sub === "create") {
          volumes.add(name);
          const labels: Record<string, string> = {};
          for (let i = 0; i < rest.length; i++) {
            if (rest[i] !== "--label") continue;
            const [key = "", value = ""] = rest[++i]!.split("=");
            labels[key] = value;
          }
          volumeLabels.set(name, labels);
          return ok(name);
        }
        if (sub === "rm") {
          const attached = [...containers.values()].some((c) => c.volume === name);
          if (attached) return fail(`volume is in use`);
          volumeLabels.delete(name);
          return volumes.delete(name) ? ok(name) : fail(`Error: no such volume: ${name}`);
        }
        return fail(`unknown volume subcommand ${sub}`);
      }
      case "run": {
        if (!rest.includes("--name")) {
          const target = rest.find((arg) => arg.endsWith(":/to") || arg.endsWith(":/to:ro"))?.split(":")[0];
          if (rest.some((arg) => arg.includes("cp -a /from/. /to/") && arg.includes(".qm-local-volume-migrated-v1"))) {
            if (target) migratedVolumes.add(target);
            return ok("migration");
          }
          if (rest.some((arg) => arg.includes("/to/.qm-local-volume-migrated-v1"))) {
            return target && migratedVolumes.has(target) ? ok() : fail("not found");
          }
          return ok("helper");
        }
        const c = parseRun(rest);
        if (self.imageMissing) return fail("Unable to find image");
        if (containers.has(c.name)) return fail(`Conflict. The container name "/${c.name}" is already in use`);
        if (self.conflictOnRun) {
          c.labels["qm.provision"] = "winning-provision";
          containers.set(c.name, c);
          const networkIndex = rest.indexOf("--network");
          if (networkIndex !== -1) networkMembers.get(rest[networkIndex + 1]!)?.add(c.name);
          return fail(`Conflict. The container name "/${c.name}" is already in use`);
        }
        containers.set(c.name, c);
        const networkIndex = rest.indexOf("--network");
        if (networkIndex !== -1) networkMembers.get(rest[networkIndex + 1]!)?.add(c.name);
        self.runCount++;
        if (self.failRun) return fail("container entered Created state");
        return ok("deadbeef");
      }
      case "create": {
        const c = parseRun(rest);
        if (containers.has(c.name)) return fail(`Conflict. The container name "/${c.name}" is already in use`);
        c.running = false;
        containers.set(c.name, c);
        return ok("owner-container");
      }
      case "start": {
        const c = containers.get(rest[0]!);
        if (!c) return fail("Error: No such container");
        c.running = true;
        return ok(rest[0]!);
      }
      case "stop": {
        const c = containers.get(rest[rest.length - 1]!);
        if (!c) return fail("Error: No such container");
        if (self.failStop) return fail("stop failed");
        c.running = false;
        return ok();
      }
      case "rm": {
        const name = rest[rest.length - 1]!;
        containers.delete(name);
        for (const members of networkMembers.values()) members.delete(name);
        return ok(name);
      }
      case "port": {
        const c = containers.get(rest[0]!);
        if (!c || !c.running) return fail("Error: No such container or not running");
        return ok(`127.0.0.1:${daemonPort}`);
      }
      default:
        return fail(`fake docker: unsupported command ${cmd}`);
    }
  }

  return self;
}
