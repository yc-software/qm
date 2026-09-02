import assert from "node:assert/strict";
import { test } from "node:test";
import { createDockerDeployProvider, dockerDaemonFailure } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import type { DockerExec } from "../src/sandbox/docker-exec.ts";
import { scopeId } from "../src/types.ts";
import { installFakeDocker } from "./support/fake-docker.ts";

test("control mode fails closed unless its workload network is internal", () => {
  const image = "example.invalid/control-proxy@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.throws(
    () => createDockerDeployProvider({ controlNetwork: "qm-control", controlProxyImage: image }),
    /requires networkInternal=true/,
  );
  assert.throws(
    () =>
      createDockerDeployProvider({ controlNetwork: "qm-control", controlProxyImage: image, networkInternal: false }),
    /requires networkInternal=true/,
  );
});

test("control mode rejects a mutable control proxy image", () => {
  assert.throws(
    () =>
      createDockerDeployProvider({
        controlNetwork: "qm-control",
        controlProxyImage: "alpine/socat:1.8.0.0",
        networkInternal: true,
      }),
    /immutable digest/,
  );
});

test("control mode does not mistake a Docker inspection failure for a missing App network", async () => {
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U-network-failure"),
    createdBy: "U-network-failure",
    entrypoint: "node server.js",
    snapshotDir: "/snap/network-failure",
  });
  const provider = createDockerDeployProvider({
    dockerExec: async (args) =>
      args[0] === "network" && args[1] === "inspect"
        ? { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }
        : { code: 0, stdout: "", stderr: "" },
    controlNetwork: "qm-control",
    controlProxyImage:
      "example.invalid/control-proxy@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    networkInternal: true,
  });

  await assert.rejects(provider.apply(deployment, deployment.versions[0]!), /network inspect.*Docker daemon/);
});

test("control mode rechecks a racing App network before accepting it", async () => {
  let inspections = 0;
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U-network-race"),
    createdBy: "U-network-race",
    entrypoint: "node server.js",
    snapshotDir: "/snap/network-race",
  });
  const provider = createDockerDeployProvider({
    dockerExec: async (args) => {
      if (args[0] === "network" && args[1] === "inspect") {
        inspections++;
        return inspections === 1
          ? { code: 1, stdout: "", stderr: "No such network" }
          : { code: 0, stdout: "false\n", stderr: "" };
      }
      if (args[0] === "network" && args[1] === "create") return { code: 1, stdout: "", stderr: "already exists" };
      return { code: 0, stdout: "", stderr: "" };
    },
    controlNetwork: "qm-control",
    controlProxyImage:
      "example.invalid/control-proxy@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    networkInternal: true,
  });

  await assert.rejects(provider.apply(deployment, deployment.versions[0]!), /must be internal/);
});

test("Docker deployments use isolated networks and remove them on destroy", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "image") return { code: 0, stdout: "sha256:proxy\n", stderr: "" };
    return {
      code: args[1] === "inspect" ? 1 : 0,
      stdout: "",
      stderr: args[1] === "inspect" ? "No such network" : "",
    };
  };
  const store = createDeployStore();
  const first = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/one",
  });
  const second = await store.create({
    ownerScopeId: scopeId("personal", "U2"),
    createdBy: "U2",
    entrypoint: "node server.js",
    snapshotDir: "/snap/two",
  });
  const provider = createDockerDeployProvider({ dockerExec });

  await provider.apply(first, first.versions[0]!);
  await provider.apply(second, second.versions[0]!);
  await provider.destroy(first);

  const firstName = `agent-deploy-${first.id.slice(0, 12)}`;
  const secondName = `agent-deploy-${second.id.slice(0, 12)}`;
  assert.ok(calls.some((args) => args.join(" ") === `network create ${firstName}-net`));
  assert.ok(calls.some((args) => args.join(" ") === `network create ${secondName}-net`));
  assert.ok(calls.some((args) => args.join(" ").includes(`--name ${firstName} --network ${firstName}-net`)));
  assert.ok(calls.some((args) => args.join(" ").includes(`--name ${secondName} --network ${secondName}-net`)));
  assert.ok(calls.some((args) => args.join(" ") === `network rm ${firstName}-net`));
});

test("an isolated Docker daemon publishes Apps only to its configured peer on an internal network", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    return {
      code: args[1] === "inspect" ? 1 : 0,
      stdout: "",
      stderr: args[1] === "inspect" ? "No such network" : "",
    };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U3"),
    createdBy: "U3",
    entrypoint: "node server.js",
    snapshotDir: "/snap/isolated",
  });
  const provider = createDockerDeployProvider({
    dockerExec,
    endpointHost: "host.docker.internal",
    networkInternal: true,
  });

  const endpoint = await provider.apply(deployment, deployment.versions[0]!);

  const name = `agent-deploy-${deployment.id.slice(0, 12)}`;
  assert.equal(endpoint.host, "host.docker.internal");
  assert.ok(calls.some((args) => args.join(" ") === `network create --internal ${name}-net`));
});

test("an App control proxy exposes the App to Core without attaching Core to the App network", async () => {
  const calls: string[][] = [];
  const networks = new Set<string>();
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "image") return { code: 0, stdout: "sha256:proxy\n", stderr: "" };
    if (args[0] === "network" && args[1] === "inspect") {
      return networks.has(args.at(-1)!)
        ? { code: 0, stdout: "true\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "No such network" };
    }
    if (args[0] === "network" && args[1] === "create") {
      networks.add(args.at(-1)!);
      return { code: 0, stdout: "", stderr: "" };
    }
    return {
      code: args[1] === "inspect" ? 1 : 0,
      stdout: "",
      stderr: args[1] === "inspect" ? "No such network" : "",
    };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U6"),
    createdBy: "U6",
    entrypoint: "node server.js",
    snapshotDir: "/snap/proxied-app",
  });
  const provider = createDockerDeployProvider({
    dockerExec,
    controlNetwork: "qm-control",
    controlProxyImage:
      "example.invalid/control-proxy@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    networkInternal: true,
  });

  const endpoint = await provider.apply(deployment, deployment.versions[0]!);

  const name = `agent-deploy-${deployment.id.slice(0, 12)}`;
  const proxy = `qm-control-${name}`;
  assert.deepEqual(endpoint, { host: proxy, port: 8080 });
  assert.ok(calls.some((args) => args.join(" ") === `network connect qm-control ${proxy}`));
  const relay = calls.find((args) => args[0] === "run" && args.includes(proxy))!;
  for (const arg of ["--read-only", "--cap-drop", "--security-opt", "--pids-limit", "--memory", "--cpus", "--user"]) {
    assert.ok(relay.includes(arg), arg);
  }
  const run = calls.find((args) => args[0] === "run" && args.includes(name))!;
  assert.equal(run.includes("-p"), false);
  assert.equal(
    calls.some((args) => args.join(" ").includes(`network connect ${name}-net qm-core`)),
    false,
  );
});

test("control mode rejects an existing App network that permits egress", async () => {
  const dockerExec: DockerExec = async (args) => {
    if (args[0] === "network" && args[1] === "inspect") return { code: 0, stdout: "false\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U7"),
    createdBy: "U7",
    entrypoint: "node server.js",
    snapshotDir: "/snap/non-internal",
  });
  const provider = createDockerDeployProvider({
    dockerExec,
    controlNetwork: "qm-control",
    controlProxyImage:
      "example.invalid/control-proxy@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    networkInternal: true,
  });

  await assert.rejects(provider.apply(deployment, deployment.versions[0]!), /must be internal/);
});

test("control mode refuses a legacy App with a published port so it is safely reprovisioned", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "inspect" && args.includes("{{json .HostConfig.PortBindings}}")) {
      return { code: 0, stdout: '{"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"9200"}]}', stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U8"),
    createdBy: "U8",
    entrypoint: "node server.js",
    snapshotDir: "/snap/legacy-port",
  });
  await store.setEndpoint(deployment.id, { host: "127.0.0.1", port: 9200 });
  const running = (await store.get(deployment.id))!;
  const provider = createDockerDeployProvider({
    dockerExec,
    controlNetwork: "qm-control",
    controlProxyImage:
      "example.invalid/control-proxy@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    networkInternal: true,
  });

  assert.equal(await provider.resolveEndpoint!(running, running.versions[0]!), null);
  assert.equal(
    calls.some((args) => args[0] === "network"),
    false,
  );
  assert.equal(
    calls.some((args) => args[0] === "run"),
    false,
  );
});

test("control mode resolves an unported App through its relay", async () => {
  const calls: string[][] = [];
  let appName = "";
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "image") return { code: 0, stdout: "sha256:proxy\n", stderr: "" };
    if (args[0] === "inspect" && args.includes("{{json .HostConfig.PortBindings}}")) {
      return { code: 0, stdout: "{}", stderr: "" };
    }
    if (args[0] === "inspect" && args.includes("--format")) {
      return { code: 0, stdout: JSON.stringify({ [`${appName}-net`]: {} }), stderr: "" };
    }
    if (args[0] === "inspect") return { code: 1, stdout: "", stderr: "No such object" };
    if (args[0] === "network" && args[1] === "inspect") return { code: 0, stdout: "true\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U9"),
    createdBy: "U9",
    entrypoint: "node server.js",
    snapshotDir: "/snap/unported",
  });
  appName = `agent-deploy-${deployment.id.slice(0, 12)}`;
  await store.setEndpoint(deployment.id, { host: "127.0.0.1", port: 9200 });
  const running = (await store.get(deployment.id))!;
  const provider = createDockerDeployProvider({
    dockerExec,
    controlNetwork: "qm-control",
    controlProxyImage:
      "example.invalid/control-proxy@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    networkInternal: true,
  });

  assert.deepEqual(await provider.resolveEndpoint!(running, running.versions[0]!), {
    host: `qm-control-${appName}`,
    port: 8080,
  });
  assert.ok(calls.some((args) => args[0] === "run" && args.includes(`qm-control-${appName}`)));
});

test("destroy cleans an App relay and network when the App is already gone", async () => {
  const calls: string[][] = [];
  let appName = "";
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "rm" && args.at(-1) === appName) return { code: 1, stdout: "", stderr: "No such container" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U10"),
    createdBy: "U10",
    entrypoint: "node server.js",
    snapshotDir: "/snap/missing-app",
  });
  appName = `agent-deploy-${deployment.id.slice(0, 12)}`;
  const provider = createDockerDeployProvider({
    dockerExec,
    controlNetwork: "qm-control",
    controlProxyImage:
      "example.invalid/control-proxy@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    networkInternal: true,
  });

  await provider.destroy(deployment);

  assert.ok(calls.some((args) => args.join(" ") === `rm -f qm-control-${appName}`));
  assert.ok(calls.some((args) => args.join(" ") === `network rm ${appName}-net`));
});

test("an App relay with an extra network is recreated before reuse", async () => {
  const fake = installFakeDocker(9200);
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U11"),
    createdBy: "U11",
    entrypoint: "node server.js",
    snapshotDir: "/snap/app-extra-network",
  });
  const provider = createDockerDeployProvider({
    dockerExec: fake.dockerExec,
    controlNetwork: "qm-control",
    controlProxyImage:
      "example.invalid/control-proxy@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    networkInternal: true,
  });
  const app = `agent-deploy-${deployment.id.slice(0, 12)}`;
  const proxy = `qm-control-${app}`;
  await provider.apply(deployment, deployment.versions[0]!);
  fake.connections.add(`shared-network|${proxy}`);
  const before = fake.runCount;

  await provider.apply(deployment, deployment.versions[0]!);

  assert.equal(fake.runCount, before + 2);
  assert.equal(fake.connections.has(`shared-network|${proxy}`), false);
});

test("Docker provider migrates running deployments off the legacy shared network", async () => {
  const calls: string[][] = [];
  let containerName = "";
  let connectAttempts = 0;
  let targetAttached = false;
  let legacyAttached = true;
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args.join(" ") === "network inspect --format {{range .Containers}}{{println .Name}}{{end}} agent-deploynet") {
      return { code: 0, stdout: legacyAttached ? `${containerName}\n` : "", stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "No such network" };
    if (args[0] === "network" && args[1] === "connect" && ++connectAttempts === 1) {
      return { code: 1, stdout: "", stderr: "transient" };
    }
    if (args[0] === "network" && args[1] === "connect") targetAttached = true;
    if (args[0] === "network" && args[1] === "disconnect") legacyAttached = false;
    if (args[0] === "inspect") {
      return {
        code: 0,
        stdout: JSON.stringify({
          ...(legacyAttached ? { "agent-deploynet": {} } : {}),
          ...(targetAttached ? { [`${containerName}-net`]: {} } : {}),
        }),
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/legacy",
  });
  containerName = `agent-deploy-${deployment.id.slice(0, 12)}`;
  await store.setEndpoint(deployment.id, { host: "127.0.0.1", port: 9200 });
  const running = (await store.get(deployment.id))!;
  const provider = createDockerDeployProvider({ dockerExec });

  assert.deepEqual(await provider.resolveEndpoint!(running, running.versions[0]!), running.endpoint);
  assert.equal(connectAttempts, 2);
  assert.ok(calls.some((args) => args.join(" ") === `network connect ${containerName}-net ${containerName}`));
  assert.ok(calls.some((args) => args.join(" ") === `network disconnect agent-deploynet ${containerName}`));
});

test("constructing a Docker provider does not inspect or migrate unrelated deployments", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };

  createDockerDeployProvider({ dockerExec });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);
});

test("an unrelated legacy migration failure does not block a new deployment", async () => {
  const dockerExec: DockerExec = async (args) => {
    if (args.join(" ") === "network inspect --format {{range .Containers}}{{println .Name}}{{end}} agent-deploynet") {
      return { code: 0, stdout: "agent-deploy-broken\n", stderr: "" };
    }
    if (args[0] === "inspect") return { code: 1, stdout: "", stderr: "daemon unavailable" };
    if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "No such network" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/new",
  });
  const provider = createDockerDeployProvider({ dockerExec });

  await assert.doesNotReject(provider.apply(deployment, deployment.versions[0]!));
});

test("a transient target inspection failure does not report the deployment missing", async () => {
  const dockerExec: DockerExec = async (args) => {
    if (args.join(" ") === "network inspect --format {{range .Containers}}{{println .Name}}{{end}} agent-deploynet") {
      return { code: 1, stdout: "", stderr: "No such network" };
    }
    if (args[0] === "inspect") return { code: 1, stdout: "", stderr: "daemon unavailable" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/running",
  });
  await store.setEndpoint(deployment.id, { host: "127.0.0.1", port: 9200 });
  const running = (await store.get(deployment.id))!;
  const provider = createDockerDeployProvider({ dockerExec });

  await assert.rejects(provider.resolveEndpoint!(running, running.versions[0]!), /daemon unavailable/);
});

test("the daemon probe reports nothing when Docker answers", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    return { code: 0, stdout: "29.1.3\n", stderr: "" };
  };

  assert.equal(await dockerDaemonFailure({ dockerExec }), null);
  assert.deepEqual(calls, [["version", "-f", "{{.Server.Version}}"]]);
});

test("the daemon probe reports why Docker is unreachable", async () => {
  const dockerExec: DockerExec = async () => ({
    code: 1,
    stdout: "",
    stderr: "dial unix /var/run/docker.sock: connect: no such file or directory\n",
  });

  assert.equal(
    await dockerDaemonFailure({ dockerExec }),
    "dial unix /var/run/docker.sock: connect: no such file or directory",
  );
});

test("the daemon probe reports a failed probe rather than throwing", async () => {
  const dockerExec: DockerExec = async () => {
    throw new Error("spawn docker ENOENT");
  };

  assert.equal(await dockerDaemonFailure({ dockerExec }), "spawn docker ENOENT");
});

test("the daemon probe reports the exit code when Docker is silent", async () => {
  const dockerExec: DockerExec = async () => ({ code: 7, stdout: "", stderr: "" });

  assert.equal(await dockerDaemonFailure({ dockerExec }), "exit 7");
});

test("the daemon probe reports a hung daemon as a timeout", async () => {
  const dockerExec: DockerExec = async () => ({ code: -1, stdout: "", stderr: "" });

  assert.equal(await dockerDaemonFailure({ dockerExec }), "no response within 10s");
});
