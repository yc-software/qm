import assert from "node:assert/strict";
import { test } from "node:test";
import { createDockerDeployProvider, dockerDaemonFailure } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import type { DockerExec } from "../src/sandbox/docker-exec.ts";
import { scopeId } from "../src/types.ts";
import { testDeployBackings } from "./support/test-database.ts";

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
  const store = createDeployStore(testDeployBackings());
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

test("a transient docker failure does not report the deployment missing", async () => {
  const dockerExec: DockerExec = async () => ({ code: 1, stdout: "", stderr: "daemon unavailable" });
  const store = createDeployStore(testDeployBackings());
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

test("a deployment is missing unless docker lists a container with exactly its name", async () => {
  const dockerExec: DockerExec = async (args) => {
    if (args[0] === "ps") return { code: 0, stdout: "agent-deploy-other\tbridge\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "daemon unavailable" };
  };
  const store = createDeployStore(testDeployBackings());
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/gone",
  });
  await store.setEndpoint(deployment.id, { host: "127.0.0.1", port: 9200 });
  const running = (await store.get(deployment.id))!;
  const provider = createDockerDeployProvider({ dockerExec });

  assert.equal(await provider.resolveEndpoint!(running, running.versions[0]!), null);
  assert.equal(await provider.logs!(running, { tailLines: 10 }), null);
});

test("a deployment network created concurrently is reused, and a create that leaves none fails", async () => {
  let networkExists = false;
  let createLeavesNetwork = true;
  const dockerExec: DockerExec = async (args) => {
    if (args[0] === "network" && args[1] === "inspect") return { code: networkExists ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "network" && args[1] === "create") {
      networkExists = createLeavesNetwork;
      return { code: 1, stdout: "", stderr: "network with name x already exists" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore(testDeployBackings());
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/race",
  });
  const provider = createDockerDeployProvider({ dockerExec });

  await assert.doesNotReject(provider.apply(deployment, deployment.versions[0]!));
  networkExists = false;
  createLeavesNetwork = false;
  await assert.rejects(
    provider.apply(deployment, deployment.versions[0]!),
    /network create .* failed: .*already exists/,
  );
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

test("a Docker app that only answers 5xx fails publish, reports its output and leaves no container", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    const script = args[0] === "exec" ? args.at(-1)! : "";
    if (script.includes("http_code")) return { code: 96, stdout: "500\n", stderr: "" };
    if (script.startsWith("tail -c")) return { code: 0, stdout: "boot: database unreachable", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const reported: Array<{ code: string; message: string }> = [];
  const store = createDeployStore(testDeployBackings());
  const d = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/broken",
  });
  const provider = createDockerDeployProvider({ dockerExec, onError: (e) => reported.push(e) });
  await assert.rejects(provider.apply(d, d.versions[0]!), /answered HTTP 500 on \/ .*database unreachable/s);
  assert.deepEqual(
    reported.map((e) => e.code),
    ["app_start_failed"],
  );
  assert.match(reported[0]!.message, new RegExp(`\\(deployment ${d.id}\\)`), "the record names the deployment");
  assert.equal(calls.at(-2)!.join(" "), `rm -f agent-deploy-${d.id.slice(0, 12)}`);
});
