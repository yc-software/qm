import assert from "node:assert/strict";
import { test } from "node:test";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
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
  assert.ok(calls.some((args) => args.join(" ") === `network create ${firstName}-net`));
  assert.ok(calls.some((args) => args.join(" ") === `network create ${secondName}-net`));
  assert.ok(calls.some((args) => args.join(" ").includes(`--name ${firstName} --network ${firstName}-net`)));
  assert.ok(calls.some((args) => args.join(" ").includes(`--name ${secondName} --network ${secondName}-net`)));
  assert.ok(calls.some((args) => args.join(" ") === `network rm ${firstName}-net`));
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

test("deployed apps get a writable /data mount and are told where it is", async () => {
  const calls: string[][] = [];
  const made: string[] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    return { code: args[1] === "inspect" ? 1 : 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const d = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/app",
  });
  const provider = createDockerDeployProvider({ dockerExec, dataRoot: "/var/qm-data", mkdir: (p) => made.push(p) });

  await provider.apply(d, d.versions[0]!);

  const run = calls.find((args) => args[0] === "run")!;
  const joined = run.join(" ");
  assert.equal(provider.profile.dataDir, "/data");
  assert.ok(made.includes(`/var/qm-data/${d.id}`), "per-deployment data directory is created on the host");
  assert.ok(joined.includes(`-v /var/qm-data/${d.id}:/data`), "the data directory is mounted writable");
  assert.ok(joined.includes("-v /snap/app:/app:ro"), "the snapshot stays read-only");
  assert.ok(joined.includes("-e DATA_DIR=/data"), "the app is told where its writable directory is");
});

test("a redeploy reuses the port already recorded on the deployment", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    return { code: args[1] === "inspect" ? 1 : 0, stdout: "", stderr: "" };
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

  const before = createDockerDeployProvider({ dockerExec, mkdir: () => {} });
  const firstEndpoint = await before.apply(first, first.versions[0]!);
  const secondEndpoint = await before.apply(second, second.versions[0]!);
  assert.notEqual(firstEndpoint.port, secondEndpoint.port);

  // A fresh provider models a process restart: the in-memory counter is gone,
  // but the ports the deployments already hold are still on their records.
  const after = createDockerDeployProvider({ dockerExec, mkdir: () => {} });
  const rebound = await after.apply({ ...second, endpoint: secondEndpoint }, second.versions[0]!);
  assert.equal(rebound.port, secondEndpoint.port, "a restart does not re-hand out a port that is already taken");

  const third = await store.create({
    ownerScopeId: scopeId("personal", "U3"),
    createdBy: "U3",
    entrypoint: "node server.js",
    snapshotDir: "/snap/three",
  });
  const fresh = await after.apply(third, third.versions[0]!);
  assert.notEqual(fresh.port, secondEndpoint.port, "a new deployment does not collide with a reused port");
});
