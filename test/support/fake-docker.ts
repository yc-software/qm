import type { DockerExec } from "../../src/sandbox/local-sandbox.ts";

export interface FakeContainer {
  name: string;
  imageId: string;
  running: boolean;
  labels: Record<string, string>;
  volume?: string;
  args: string[];
}

export interface FakeDocker {
  dockerExec: DockerExec;
  containers: Map<string, FakeContainer>;
  volumes: Set<string>;
  networks: Set<string>;
  connections: Set<string>;
  runCount: number;
  daemonDown: boolean;
  imageMissing: boolean;
  imageId: string;
  imageFingerprint: string;
  labelInspectFails: boolean;
}

export function installFakeDocker(daemonPort: number): FakeDocker {
  const containers = new Map<string, FakeContainer>();
  const volumes = new Set<string>();
  const networks = new Set<string>();
  const connections = new Set<string>();
  const self: FakeDocker = {
    containers,
    volumes,
    networks,
    connections,
    runCount: 0,
    daemonDown: false,
    imageMissing: false,
    imageId: "sha256:image-v1",
    imageFingerprint: "",
    labelInspectFails: false,
    dockerExec: async (args) => exec(args),
  };

  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });

  function parseRun(args: string[]): FakeContainer {
    const c: FakeContainer = { name: "", imageId: self.imageId, running: true, labels: {}, args };
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
    const [cmd, ...rest] = args;
    if (self.daemonDown) return fail("Cannot connect to the Docker daemon");
    switch (cmd) {
      case "version":
        return ok("Docker version fake");
      case "image": {
        if (self.imageMissing) return fail("Error: No such image");
        if (rest.includes("{{.Id}}")) return ok(self.imageId);
        if (self.labelInspectFails) return fail('map has no entry for key "Labels"');
        return ok(self.imageFingerprint);
      }
      case "inspect": {
        const name = rest[rest.length - 1]!;
        const c = containers.get(name);
        if (!c) return fail(`Error: No such object: ${name}`);
        return ok(`${c.running} ${c.imageId}`);
      }
      case "network": {
        const [sub, name] = rest as [string, string];
        if (sub === "inspect") return networks.has(name) ? ok(name) : fail(`Error: No such network: ${name}`);
        if (sub === "create") {
          if (networks.has(name)) return fail(`network with name ${name} already exists`);
          networks.add(name);
          return ok(name);
        }
        if (sub === "rm") return networks.delete(name) ? ok(name) : fail(`Error: No such network: ${name}`);
        if (sub === "connect" || sub === "disconnect") {
          const container = rest[2]!;
          const key = `${name}|${container}`;
          if (sub === "connect") {
            if (connections.has(key)) return fail("endpoint already exists");
            connections.add(key);
          } else connections.delete(key);
          return ok(key);
        }
        return fail(`unknown network subcommand ${sub}`);
      }
      case "volume": {
        const [sub, name] = rest as [string, string];
        if (sub === "inspect") return volumes.has(name) ? ok(name) : fail(`Error: no such volume: ${name}`);
        if (sub === "create") {
          volumes.add(name);
          return ok(name);
        }
        if (sub === "rm") {
          const attached = [...containers.values()].some((c) => c.volume === name);
          if (attached) return fail(`volume is in use`);
          return volumes.delete(name) ? ok(name) : fail(`Error: no such volume: ${name}`);
        }
        return fail(`unknown volume subcommand ${sub}`);
      }
      case "run": {
        const c = parseRun(rest);
        if (self.imageMissing) return fail("Unable to find image");
        if (containers.has(c.name)) return fail(`Conflict. The container name "/${c.name}" is already in use`);
        containers.set(c.name, c);
        self.runCount++;
        return ok("deadbeef");
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
        c.running = false;
        return ok();
      }
      case "rm": {
        const name = rest[rest.length - 1]!;
        containers.delete(name);
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
