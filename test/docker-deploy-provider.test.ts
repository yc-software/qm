import assert from "node:assert/strict";
import { test } from "node:test";
import { createDockerDeployProvider, dockerDaemonFailure } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import type { DockerExec } from "../src/sandbox/docker-exec.ts";
import { scopeId } from "../src/types.ts";
import { createTenantContext, runWithTenant } from "../src/tenancy/context.ts";

test("Docker deployments use isolated networks and remove them on destroy", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    return {
      code: args[1] === "inspect" ? 1 : 0,
      stdout: args[0] === "port" ? "127.0.0.1:49152\n" : "",
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
  assert.ok(
    calls.filter((args) => args[0] === "run").every((args) => args[args.indexOf("-p") + 1] === "127.0.0.1::8080"),
  );
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
    if (args[0] === "port") return { code: 0, stdout: "127.0.0.1:9200\n", stderr: "" };
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
    if (args[0] === "port") return { code: 0, stdout: "127.0.0.1:49152\n", stderr: "" };
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

test("tenant Docker deployments use distinct names and Docker-assigned ports after restarts", async () => {
  const calls: string[][] = [];
  const assignments = new Map<string, number>();
  let nextPort = 49152;
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "run") assignments.set(args[args.indexOf("--name") + 1]!, nextPort++);
    if (args[0] === "port") {
      const port = assignments.get(args[1]!);
      return { code: port ? 0 : 1, stdout: port ? `127.0.0.1:${port}\n` : "", stderr: port ? "" : "No such container" };
    }
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify({ [`${args.at(-1)}-net`]: {} }), stderr: "" };
    if (args[0] === "rm") assignments.delete(args.at(-1)!);
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/app",
  });
  const first = createTenantContext({ id: "first", env: {}, pooled: true });
  const second = createTenantContext({ id: "second", env: {}, pooled: true });
  const providerA = runWithTenant(first, () => createDockerDeployProvider({ dockerExec }));
  const providerB = runWithTenant(second, () => createDockerDeployProvider({ dockerExec }));
  const endpoints = await Promise.all([
    providerA.apply(deployment, deployment.versions[0]!),
    providerB.apply(deployment, deployment.versions[0]!),
  ]);
  assert.deepEqual(endpoints.map((value) => value.port).sort(), [49152, 49153]);
  const names = [...assignments.keys()];
  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1]);
  assert.ok(names.every((name) => name !== `agent-deploy-${deployment.id.slice(0, 12)}`));
  assert.equal(
    new Set(calls.filter((args) => args[0] === "run").map((args) => args[args.indexOf("--network") + 1])).size,
    2,
  );
  const restarted = runWithTenant(first, () => createDockerDeployProvider({ dockerExec }));
  const stale = { ...deployment, endpoint: { host: "127.0.0.1", port: endpoints[1]!.port } };
  assert.deepEqual(await restarted.resolveEndpoint!(stale, deployment.versions[0]!), endpoints[0]);
  await providerA.destroy(deployment);
  assert.equal(assignments.size, 1);
  assert.deepEqual(await providerB.resolveEndpoint!(deployment, deployment.versions[0]!), endpoints[1]);
});

test("Docker port discovery rejects invalid bindings and cleans up failed deployments", async () => {
  const deployment = await createDeployStore().create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/app",
  });
  for (const binding of ["", "127.0.0.1:0", "127.0.0.1:65536", "0.0.0.0:49152", "127.0.0.1:49152\n127.0.0.1:49153"]) {
    const calls: string[][] = [];
    const provider = createDockerDeployProvider({
      dockerExec: async (args) => {
        calls.push(args);
        return { code: 0, stdout: args[0] === "port" ? binding : "", stderr: "" };
      },
    });
    await assert.rejects(provider.apply(deployment, deployment.versions[0]!), /docker port/);
    assert.deepEqual(calls.at(-2), ["rm", "-f", `agent-deploy-${deployment.id.slice(0, 12)}`]);
    assert.deepEqual(calls.at(-1), ["network", "rm", `agent-deploy-${deployment.id.slice(0, 12)}-net`]);
  }
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
