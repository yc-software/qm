import assert from "node:assert/strict";
import { test } from "node:test";
import { createDockerDeployProvider, dockerDaemonFailure } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import type { DockerExec } from "../src/sandbox/docker-exec.ts";
import { scopeId } from "../src/types.ts";

test("Docker deployments use isolated networks and remove them on destroy", async () => {
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
  const firstVolume = `qm-app-${first.id.slice(0, 12)}`;
  assert.ok(calls.some((args) => args.join(" ") === `network create ${firstName}-net`));
  assert.ok(calls.some((args) => args.join(" ") === `network create ${secondName}-net`));
  assert.ok(calls.some((args) => args.join(" ").includes(`--name ${firstName} --network ${firstName}-net`)));
  assert.ok(calls.some((args) => args.join(" ").includes(`--name ${secondName} --network ${secondName}-net`)));
  assert.ok(calls.some((args) => args.join(" ") === `network rm ${firstName}-net`));
  assert.ok(calls.some((args) => args.join(" ") === `volume rm ${firstVolume}`));
});

test("Docker Apps copy snapshots through managed volumes before starting", async () => {
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
    ownerScopeId: scopeId("personal", "U-app-volume"),
    createdBy: "U-app-volume",
    entrypoint: "node server.js",
    snapshotDir: "/snap/app-volume",
  });
  const provider = createDockerDeployProvider({ dockerExec });

  await provider.apply(deployment, deployment.versions[0]!);

  const app = `agent-deploy-${deployment.id.slice(0, 12)}`;
  const volume = `qm-app-${deployment.id.slice(0, 12)}`;
  const create = calls.findIndex((args) => args[0] === "create" && args.includes(app));
  const copy = calls.findIndex((args) => args[0] === "cp" && args.includes(`${app}:/app`));
  const start = calls.findIndex((args) => args[0] === "start" && args.includes(app));
  assert.ok(calls.some((args) => args.join(" ") === `volume create ${volume}`));
  assert.ok(create >= 0);
  assert.ok(copy > create);
  assert.ok(start > copy);
  assert.ok(calls[create]!.includes(`${volume}:/app`));
  assert.equal(calls[create]!.includes(`${deployment.versions[0]!.snapshotDir}:/app:ro`), false);
});

test("Docker Apps remove the managed volume when snapshot delivery fails", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "No such network" };
    if (args[0] === "cp") return { code: 1, stdout: "", stderr: "copy failed" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U-app-volume-failure"),
    createdBy: "U-app-volume-failure",
    entrypoint: "node server.js",
    snapshotDir: "/snap/app-volume-failure",
  });
  const provider = createDockerDeployProvider({ dockerExec });
  const app = `agent-deploy-${deployment.id.slice(0, 12)}`;
  const volume = `qm-app-${deployment.id.slice(0, 12)}`;

  await assert.rejects(provider.apply(deployment, deployment.versions[0]!), /snapshot copy failed: copy failed/);

  const copy = calls.findIndex((args) => args[0] === "cp");
  assert.ok(calls.findLastIndex((args) => args.join(" ") === `rm -f ${app}`) > copy);
  assert.ok(calls.findLastIndex((args) => args.join(" ") === `volume rm ${volume}`) > copy);
  assert.equal(
    calls.some((args) => args[0] === "start" && args.includes(app)),
    false,
  );
});

test("Docker Apps remove their workload network when App-volume creation fails", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "No such network" };
    if (args[0] === "volume" && args[1] === "create") return { code: 1, stdout: "", stderr: "volume unavailable" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U-app-volume-create-failure"),
    createdBy: "U-app-volume-create-failure",
    entrypoint: "node server.js",
    snapshotDir: "/snap/app-volume-create-failure",
  });
  const provider = createDockerDeployProvider({ dockerExec });
  const app = `agent-deploy-${deployment.id.slice(0, 12)}`;

  await assert.rejects(provider.apply(deployment, deployment.versions[0]!), /volume create.*volume unavailable/);

  assert.ok(calls.some((args) => args.join(" ") === `network rm ${app}-net`));
});

test("Docker Apps continue cleanup after managed-volume removal fails", async () => {
  const calls: string[][] = [];
  let deployedVolume = "";
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "No such network" };
    if (args[0] === "volume" && args[1] === "create") {
      deployedVolume = args[2]!;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "rm" && args[2] === deployedVolume) {
      return { code: 1, stdout: "", stderr: "volume is in use" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const first = await store.create({
    ownerScopeId: scopeId("personal", "U-app-volume-destroy-failure"),
    createdBy: "U-app-volume-destroy-failure",
    entrypoint: "node server.js",
    snapshotDir: "/snap/app-volume-destroy-failure",
  });
  const second = await store.create({
    ownerScopeId: scopeId("personal", "U-app-volume-destroy-retry"),
    createdBy: "U-app-volume-destroy-retry",
    entrypoint: "node server.js",
    snapshotDir: "/snap/app-volume-destroy-retry",
  });
  const provider = createDockerDeployProvider({ dockerExec, basePort: 9800 });
  const firstEndpoint = await provider.apply(first, first.versions[0]!);
  const app = `agent-deploy-${first.id.slice(0, 12)}`;

  await assert.rejects(provider.destroy(first), /docker volume rm.*volume is in use/);

  assert.ok(calls.some((args) => args.join(" ") === `network rm ${app}-net`));
  assert.deepEqual(await provider.apply(second, second.versions[0]!), firstEndpoint);
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
    if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
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
    if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
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
