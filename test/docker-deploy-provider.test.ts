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
  assert.ok(
    calls.some((args) => args[0] === "create" && args.includes("-p") && args.some((a) => a.startsWith("127.0.0.1:"))),
    "fallback mode still publishes a loopback host port",
  );
  assert.ok(calls.some((args) => args[0] === "cp" && args[1] === "/snap/one/."), "snapshot is copied in");
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

test("shared-network mode copies the snapshot in and reaches the app by container alias", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/shared",
  });
  const provider = createDockerDeployProvider({ dockerExec, network: "qm-default" });

  const endpoint = await provider.apply(deployment, deployment.versions[0]!);
  const container = `agent-deploy-${deployment.id.slice(0, 12)}`;
  assert.deepEqual(endpoint, { host: container, port: 8080 });

  const flat = calls.map((args) => args.join(" "));
  const createIdx = flat.findIndex((c) => c.startsWith("create "));
  const cpIdx = flat.findIndex((c) => c.startsWith("cp "));
  const startIdx = flat.findIndex((c) => c.startsWith("start "));
  assert.ok(createIdx !== -1, "container is created, not run");
  assert.equal(cpIdx, createIdx + 1, "snapshot is copied right after create");
  assert.equal(startIdx, cpIdx + 1, "container starts only after the copy");
  assert.equal(flat[cpIdx], `cp /snap/shared/. ${container}:/app`);
  assert.ok(flat[createIdx]!.includes(`--network qm-default`));
  assert.ok(flat[createIdx]!.includes(`--network-alias ${container}`));
  assert.ok(!flat[createIdx]!.includes(" -v "), "no bind mount across the core boundary");
  assert.ok(!flat[createIdx]!.includes(" -p "), "no host port publishing in shared-network mode");
  assert.ok(!flat.some((c) => c.startsWith("network ")), "shared network is never created or removed");

  await provider.destroy(deployment);
  assert.ok(!calls.some((args) => args[0] === "network"), "destroy leaves the shared network alone");

  await store.setEndpoint(deployment.id, endpoint);
  const stored = (await store.get(deployment.id))!;
  const resolved = await provider.resolveEndpoint!(stored, stored.versions[0]!);
  assert.deepEqual(resolved, { host: container, port: 8080 });
});

test("shared-network mode cleans up the container when the snapshot copy fails", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "cp") return { code: 1, stdout: "", stderr: "no such directory" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/broken",
  });
  const provider = createDockerDeployProvider({ dockerExec, network: "qm-default" });

  await assert.rejects(provider.apply(deployment, deployment.versions[0]!), /snapshot copy failed/);
  assert.ok(calls.some((args) => args[0] === "rm" && args.includes(`agent-deploy-${deployment.id.slice(0, 12)}`)));
  assert.ok(!calls.some((args) => args[0] === "network"), "cleanup never touches the shared network");
});

test("shared-network mode cleans up the container when start fails", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "start") return { code: 1, stdout: "", stderr: "start failed" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/no-start",
  });
  const provider = createDockerDeployProvider({ dockerExec, network: "qm-default" });

  await assert.rejects(provider.apply(deployment, deployment.versions[0]!), /deploy start failed/);
  assert.ok(calls.some((args) => args[0] === "cp" && args[1] === "/snap/no-start/."), "copy happened before start");
  assert.ok(calls.some((args) => args[0] === "rm" && args[1] === "-f"));
  assert.ok(!calls.some((args) => args[0] === "network"));
});

test("shared-network mode re-materializes deployments stored with a loopback endpoint", async () => {
  const dockerExec: DockerExec = async () => ({ code: 0, stdout: "", stderr: "" });
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/stale",
  });
  await store.setEndpoint(deployment.id, { host: "127.0.0.1", port: 9200 });
  const stale = (await store.get(deployment.id))!;
  const provider = createDockerDeployProvider({ dockerExec, network: "qm-default" });

  assert.equal(await provider.resolveEndpoint!(stale, stale.versions[0]!), null);
});
