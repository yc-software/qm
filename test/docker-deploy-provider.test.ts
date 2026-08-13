import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import type { Deployment, DeploymentVersion } from "../src/deploy/deploy-store.ts";
import type { DockerExec } from "../src/sandbox/docker-exec.ts";

function fixture(id: string): { deployment: Deployment; version: DeploymentVersion } {
  const version = {
    version: 1,
    createdAt: 1,
    entrypoint: "node server.js",
    snapshotDir: `/data/deployments/${id}`,
  };
  return {
    deployment: {
      id,
      ownerScopeId: "personal:U1",
      createdBy: "U1",
      currentVersion: 1,
      status: "running",
      endpoint: null,
      versions: [version],
    },
    version,
  };
}

function fakeDocker() {
  const calls: string[][] = [];
  const networks = new Set<string>();
  const members = new Set<string>();
  const running = new Set<string>();
  const versions = new Map<string, number>();
  const labels = new Map<string, Record<string, string>>();
  const mountSources = new Map<string, string[]>();
  const networkMembers = new Map<string, Set<string>>();
  const networkLabels = new Map<string, Record<string, string>>();
  const ports = new Map<string, number>();
  const state = { engineVersion: "29.0.0", failNextRun: false, conflictNextRun: false };
  let nextPort = 49152;
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });
  const exec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "network" && args[1] === "inspect") {
      const network = args.at(-1)!;
      if (!networks.has(network)) return fail("not found");
      const format = args[args.indexOf("-f") + 1] ?? "";
      const label = format.match(/\.Labels "([^"]+)"/)?.[1];
      return ok(label ? (networkLabels.get(network)?.[label] ?? "") : network);
    }
    if (args[0] === "network" && args[1] === "create") {
      const network = args.at(-1)!;
      networks.add(network);
      networkMembers.set(network, new Set());
      const createdLabels: Record<string, string> = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== "--label") continue;
        const [key = "", value = ""] = args[++i]!.split("=");
        createdLabels[key] = value;
      }
      networkLabels.set(network, createdLabels);
      return ok(network);
    }
    if (args[0] === "network" && args[1] === "connect") {
      const network = args.at(-2)!;
      const member = args.at(-1)!;
      if (!networks.has(network)) return fail("network not found");
      const key = `${network}:${member}`;
      if (members.has(key)) return fail("endpoint already exists in network");
      members.add(key);
      networkMembers.get(network)?.add(member);
      return ok();
    }
    if (args[0] === "network" && args[1] === "disconnect") {
      const network = args.at(-2)!;
      const member = args.at(-1)!;
      members.delete(`${network}:${member}`);
      networkMembers.get(network)?.delete(member);
      return networks.has(network) ? ok() : fail("network not found");
    }
    if (args[0] === "network" && args[1] === "rm") {
      const network = args.at(-1)!;
      if (networkMembers.get(network)?.size) return fail("active endpoints");
      networkMembers.delete(network);
      networkLabels.delete(network);
      return networks.delete(network) ? ok() : fail("network not found");
    }
    if (args[0] === "version") return ok(state.engineVersion);
    if (args[0] === "rm") {
      const name = args.at(-1)!;
      running.delete(name);
      versions.delete(name);
      labels.delete(name);
      mountSources.delete(name);
      for (const networkMembersForName of networkMembers.values()) networkMembersForName.delete(name);
      return ok();
    }
    if (args[0] === "run") {
      const name = args[args.indexOf("--name") + 1]!;
      running.add(name);
      const versionLabel = args.find((arg) => arg.startsWith("qm.deploy.version="));
      versions.set(name, Number(versionLabel?.split("=")[1]));
      const runLabels: Record<string, string> = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== "--label") continue;
        const [key = "", value = ""] = args[++i]!.split("=");
        runLabels[key] = value;
      }
      labels.set(name, runLabels);
      networkMembers.get(args[args.indexOf("--network") + 1]!)?.add(name);
      if (args.includes("-p")) ports.set(name, nextPort++);
      if (state.conflictNextRun) {
        state.conflictNextRun = false;
        runLabels["qm.provision"] = "winning-provision";
        return fail("container name is already in use");
      }
      if (state.failNextRun) {
        state.failNextRun = false;
        return fail("container entered Created state");
      }
      return ok("container-id");
    }
    if (args[0] === "inspect") {
      const name = args.at(-1)!;
      const item = labels.get(name);
      if (!running.has(name) || !item) return fail("not found");
      const format = args[args.indexOf("-f") + 1] ?? "";
      if (format.includes(".Mounts")) {
        return ok(
          JSON.stringify(
            (mountSources.get(name) ?? []).map((source) => ({
              Source: source,
              Destination: "/app",
              Type: "bind",
              RW: false,
            })),
          ),
        );
      }
      if (format === '{{index .Config.Labels "qm.deploy.version"}}') {
        return ok(item["qm.deploy.version"] ?? "");
      }
      return ok(
        `true ${versions.get(name)} ${item["qm.org"] ?? ""} ${item["qm.deploy.id"] ?? ""} ${item["qm.provision"] ?? ""}`,
      );
    }
    if (args[0] === "port") {
      const port = ports.get(args[1]!);
      return port ? ok(`127.0.0.1:${port}`) : fail("not published");
    }
    return fail(`unexpected command: ${args.join(" ")}`);
  };
  return { calls, exec, labels, mountSources, networks, networkMembers, running, state, versions };
}

function deploymentKey(orgId: string, id: string): string {
  return createHash("sha256").update(`${orgId}\0${id}`).digest("hex").slice(0, 24);
}

test("containerized core uses isolated name routing and the durable core volume", async () => {
  const fake = fakeDocker();
  const provider = createDockerDeployProvider({
    dockerExec: fake.exec,
    coreContainer: "qm-acme-core",
    coreDataVolume: "qm-acme-coredata",
    coreDataDir: "/data",
    network: "qm-acme-deployments",
    orgId: "acme",
  });
  const { deployment, version } = fixture("12345678-1234-1234-1234-123456789abc");
  const key = deploymentKey("acme", deployment.id);
  assert.deepEqual(await provider.apply(deployment, version), { host: `agent-deploy-${key}`, port: 8080 });
  const run = fake.calls.find((args) => args[0] === "run")!;
  assert.equal(run.includes("-p"), false);
  assert.ok(run.includes("qm.org=acme"));
  assert.ok(
    run.includes(
      "type=volume,src=qm-acme-coredata,dst=/app,readonly,volume-subpath=deployments/12345678-1234-1234-1234-123456789abc",
    ),
  );
  assert.ok(
    fake.calls.some(
      (args) => args.join(" ") === `network connect --alias core qm-acme-deployments-${key} qm-acme-core`,
    ),
  );
  assert.deepEqual(await provider.resolveEndpoint!(deployment, version), {
    host: `agent-deploy-${key}`,
    port: 8080,
  });
});

test("host core delegates port allocation to Docker across provider restarts", async () => {
  const fake = fakeDocker();
  const first = fixture("aaaaaaaa-1234-1234-1234-123456789abc");
  const second = fixture("bbbbbbbb-1234-1234-1234-123456789abc");
  const provider = createDockerDeployProvider({ dockerExec: fake.exec });
  assert.deepEqual(await provider.apply(first.deployment, first.version), { host: "127.0.0.1", port: 49152 });
  const restarted = createDockerDeployProvider({ dockerExec: fake.exec });
  assert.deepEqual(await restarted.apply(second.deployment, second.version), { host: "127.0.0.1", port: 49153 });
  const runs = fake.calls.filter((args) => args[0] === "run");
  assert.equal(runs.length, 2);
  for (const run of runs) assert.ok(run.includes("127.0.0.1::8080"));
  assert.equal(
    runs.some((run) => run.some((arg) => arg.includes("9200"))),
    false,
  );
});

test("core volume snapshots cannot escape the configured data directory", async () => {
  const fake = fakeDocker();
  const provider = createDockerDeployProvider({
    dockerExec: fake.exec,
    coreContainer: "qm-acme-core",
    coreDataVolume: "qm-acme-coredata",
    coreDataDir: "/data",
  });
  const { deployment, version } = fixture("cccccccc-1234-1234-1234-123456789abc");
  version.snapshotDir = "/elsewhere/app";
  await assert.rejects(provider.apply(deployment, version), /outside Docker core data/);
});

test("resolve rejects a running container from an interrupted prior version", async () => {
  const fake = fakeDocker();
  const provider = createDockerDeployProvider({
    dockerExec: fake.exec,
    coreContainer: "qm-acme-core",
    coreDataVolume: "qm-acme-coredata",
    coreDataDir: "/data",
    network: "qm-acme-deployments",
  });
  const { deployment, version } = fixture("dddddddd-1234-1234-1234-123456789abc");
  await provider.apply(deployment, version);
  const next = { ...version, version: 2 };
  deployment.currentVersion = 2;
  deployment.versions.push(next);
  assert.equal(await provider.resolveEndpoint!(deployment, next), null);
  assert.deepEqual(await provider.apply(deployment, next), {
    host: `agent-deploy-${deploymentKey("default", deployment.id)}`,
    port: 8080,
  });
});

test("containerized core rejects Docker engines without volume subpaths before mutation", async () => {
  const fake = fakeDocker();
  fake.state.engineVersion = "25.0.5";
  const provider = createDockerDeployProvider({
    dockerExec: fake.exec,
    coreContainer: "qm-acme-core",
    coreDataVolume: "qm-acme-coredata",
    coreDataDir: "/data",
  });
  const { deployment, version } = fixture("eeeeeeee-1234-1234-1234-123456789abc");
  await assert.rejects(provider.apply(deployment, version), /Docker Engine 26 or newer/);
  assert.equal(
    fake.calls.some((args) => args[0] === "rm" || args[0] === "network"),
    false,
  );
});

test("a failed Docker run removes its Created container and isolated network", async () => {
  const fake = fakeDocker();
  fake.state.failNextRun = true;
  const provider = createDockerDeployProvider({ dockerExec: fake.exec, network: "qm-acme-deployments" });
  const { deployment, version } = fixture("ffffffff-1234-1234-1234-123456789abc");
  await assert.rejects(provider.apply(deployment, version), /Created state/);
  assert.equal(fake.running.size, 0);
  assert.equal(fake.networks.size, 0);
});

test("resolve does not recreate topology after destroy", async () => {
  const fake = fakeDocker();
  const provider = createDockerDeployProvider({
    dockerExec: fake.exec,
    coreContainer: "qm-acme-core",
    coreDataVolume: "qm-acme-coredata",
    coreDataDir: "/data",
    network: "qm-acme-deployments",
  });
  const { deployment, version } = fixture("abababab-1234-1234-1234-123456789abc");
  await provider.apply(deployment, version);
  await provider.destroy(deployment);
  fake.calls.length = 0;
  assert.equal(await provider.resolveEndpoint!(deployment, version), null);
  assert.equal(
    fake.calls.some((args) => args[0] === "network" && args[1] === "create"),
    false,
  );
});

test("organizations with the same deployment id cannot adopt or remove each other's app", async () => {
  const fake = fakeDocker();
  const { deployment, version } = fixture("shared-deployment-id");
  const first = createDockerDeployProvider({ dockerExec: fake.exec, orgId: "org-a" });
  const second = createDockerDeployProvider({ dockerExec: fake.exec, orgId: "org-b" });
  const firstEndpoint = await first.apply(deployment, version);
  assert.equal(await second.resolveEndpoint!(deployment, version), null);
  await second.destroy(deployment);
  assert.deepEqual(await first.resolveEndpoint!(deployment, version), firstEndpoint);
});

test("a losing deploy run never removes the winning concurrent container", async () => {
  const fake = fakeDocker();
  fake.state.conflictNextRun = true;
  const provider = createDockerDeployProvider({
    dockerExec: fake.exec,
    orgId: "acme",
    network: "qm-acme-deployments",
  });
  const { deployment, version } = fixture("concurrent-deployment");
  await assert.rejects(provider.apply(deployment, version), /already in use/);
  assert.equal(fake.running.size, 1);
  assert.equal(fake.networks.size, 1);
});

test("host reapply replaces an exact read-only legacy snapshot bind", async () => {
  const fake = fakeDocker();
  const { deployment, version } = fixture("legacy-deployment-id");
  const legacyName = `agent-deploy-${deployment.id.slice(0, 12)}`;
  fake.running.add(legacyName);
  fake.versions.set(legacyName, version.version);
  fake.labels.set(legacyName, {});
  fake.mountSources.set(legacyName, [version.snapshotDir]);
  fake.networks.add("agent-deploynet");
  fake.networkMembers.set("agent-deploynet", new Set([legacyName]));
  const provider = createDockerDeployProvider({
    dockerExec: fake.exec,
    orgId: "acme",
    network: "qm-acme-deployments",
  });
  const endpoint = await provider.apply(deployment, version);
  assert.equal(endpoint.host, "127.0.0.1");
  assert.equal(fake.running.has(legacyName), false);
  assert.equal(fake.networks.has("agent-deploynet"), false);
});

test("containerized core fails closed on an unlabeled pre-namespace container", async () => {
  const fake = fakeDocker();
  const { deployment, version } = fixture("legacy-containerized-id");
  const legacyName = `agent-deploy-${deployment.id.slice(0, 12)}`;
  fake.running.add(legacyName);
  fake.versions.set(legacyName, version.version);
  fake.labels.set(legacyName, {});
  fake.mountSources.set(legacyName, [version.snapshotDir]);
  const provider = createDockerDeployProvider({
    dockerExec: fake.exec,
    orgId: "acme",
    coreContainer: "qm-acme-core",
    coreDataVolume: "qm-acme-coredata",
    coreDataDir: "/data",
  });
  await assert.rejects(provider.apply(deployment, version), /has no organization label/);
  assert.equal(fake.running.has(legacyName), true);
});
