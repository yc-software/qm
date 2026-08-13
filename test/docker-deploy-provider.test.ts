import { test } from "node:test";
import assert from "node:assert/strict";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import type { Deployment, DeploymentVersion } from "../src/deploy/deploy-store.ts";
import type { DockerExec } from "../src/sandbox/docker-exec.ts";

const version: DeploymentVersion = {
  version: 1,
  createdAt: 1,
  entrypoint: "node server.js",
  snapshotDir: "/deploy/app",
};

const deployment: Deployment = {
  id: "12345678-1234-4123-8123-123456789abc",
  ownerScopeId: "personal:U1",
  createdBy: "U1",
  currentVersion: 1,
  status: "running",
  endpoint: null,
  versions: [version],
};

const containerName = "agent-deploy-12345678-123";
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });
const deploymentLabels = { "qm.deploy.id": deployment.id, "qm.deploy.version": String(version.version) };
const containerInfo = (Running: boolean, ExitCode: number, Labels: Record<string, string> = deploymentLabels) =>
  ok(
    JSON.stringify({
      State: { Status: Running ? "running" : "exited", Running, OOMKilled: false, ExitCode, Error: "" },
      Config: { Labels },
    }),
  );
const runningState = (labels: Record<string, string> = deploymentLabels) => containerInfo(true, 0, labels);
const exitedState = (exitCode: number) => containerInfo(false, exitCode);

test("apply rejects a container that crashes before its app becomes reachable", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("connection refused");
  });
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "run") return ok("crashed-container\n");
    if (args[0] === "port") return ok("127.0.0.1:9200\n");
    if (args[0] === "inspect") return exitedState(17);
    if (args[0] === "logs") return ok("Error: Cannot find module '/app/server.js'\n");
    return ok();
  };
  const provider = createDockerDeployProvider({ dockerExec });

  await assert.rejects(
    provider.apply(deployment, version),
    (error: Error) =>
      error.message.includes("container exited with code 17") &&
      error.message.includes("Cannot find module '/app/server.js'"),
  );
  assert.deepEqual(
    calls.filter((args) => args[0] === "rm").map((args) => args.at(-1)),
    [containerName, "crashed-container"],
  );
  assert.equal(await provider.resolveEndpoint!(deployment, version), null);
});

test(
  "apply waits for a slow-starting app to answer repeatedly before returning its endpoint",
  { timeout: 6_000 },
  async (t) => {
    const firstResponse = Promise.withResolvers<Response>();
    const probeStarted = Promise.withResolvers<void>();
    let attempts = 0;
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      assert.equal(String(input), "http://127.0.0.1:9310/");
      attempts += 1;
      if (attempts === 1) {
        probeStarted.resolve();
        return firstResponse.promise;
      }
      return new Response("ready");
    });
    const dockerExec: DockerExec = async (args) => {
      if (args[0] === "run") return ok("slow-container\n");
      if (args[0] === "port") return ok("127.0.0.1:9310\n");
      if (args[0] === "inspect") return runningState();
      return ok();
    };
    const provider = createDockerDeployProvider({ dockerExec });
    let returned = false;
    const applying = provider.apply(deployment, version).then((endpoint) => {
      returned = true;
      return endpoint;
    });

    await probeStarted.promise;
    assert.equal(returned, false);
    firstResponse.resolve(new Response("ready"));

    assert.deepEqual(await applying, { host: "127.0.0.1", port: 9310 });
    assert.ok(attempts >= 5);
  },
);

test("apply rejects a container that binds briefly and crashes during startup", { timeout: 3_000 }, async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("ready"));
  const calls: string[][] = [];
  let inspections = 0;
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "run") return ok("unstable-container\n");
    if (args[0] === "port") return ok("127.0.0.1:9200\n");
    if (args[0] === "inspect") return ++inspections === 1 ? runningState() : exitedState(23);
    return ok();
  };
  const provider = createDockerDeployProvider({ dockerExec });

  await assert.rejects(provider.apply(deployment, version), /container exited with code 23/);
  assert.deepEqual(
    calls.filter((args) => args[0] === "rm").map((args) => args.at(-1)),
    [containerName, "unstable-container"],
  );
});

test("apply rejects and removes a container that never becomes reachable", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("connection refused");
  });
  let nowCalls = 0;
  t.mock.method(Date, "now", () => (nowCalls++ < 2 ? 0 : 60_001));
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "run") return ok("unready-container\n");
    if (args[0] === "port") return ok("127.0.0.1:9200\n");
    if (args[0] === "inspect") return runningState();
    return ok();
  };
  const provider = createDockerDeployProvider({ dockerExec });

  await assert.rejects(provider.apply(deployment, version), /never became reachable on published port 8080 within 60s/);
  assert.deepEqual(
    calls.filter((args) => args[0] === "rm").map((args) => args.at(-1)),
    [containerName, "unready-container"],
  );
});

test("resolveEndpoint recovers the live Docker port and labels after restart", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("resolveEndpoint must not send application traffic");
  });
  const dockerExec: DockerExec = async (args) => {
    if (args[0] === "inspect") return runningState();
    if (args[0] === "port") return ok("127.0.0.1:9340\n");
    return ok();
  };
  const provider = createDockerDeployProvider({ dockerExec });
  const pending = { ...deployment, endpoint: { host: "127.0.0.1", port: 9999 } };
  const stored = { ...pending, appliedVersion: version.version };

  assert.equal(await provider.resolveEndpoint!(pending, version), null);
  assert.deepEqual(await provider.resolveEndpoint!(stored, version), { host: "127.0.0.1", port: 9340 });
});

test("a failed docker run removes only its provision before releasing the port", async () => {
  const calls: string[][] = [];
  let provision = "";
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "run") {
      provision = args[args.indexOf("--label") + 1]?.split("=")[1] ?? "";
      return fail("mount setup failed");
    }
    if (args[0] === "inspect") return runningState({ "qm.provision": provision });
    return ok();
  };
  const provider = createDockerDeployProvider({ dockerExec });

  await assert.rejects(provider.apply(deployment, version), /deploy run failed: mount setup failed/);
  assert.ok(provision);
  assert.deepEqual(
    calls.filter((args) => args[0] === "rm").map((args) => args.at(-1)),
    [containerName, containerName],
  );
});

test("a failed docker run never removes a different provision", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "run") return fail("name conflict");
    if (args[0] === "inspect") return runningState({ "qm.provision": "newer-winner" });
    return ok();
  };
  const provider = createDockerDeployProvider({ dockerExec });

  await assert.rejects(provider.apply(deployment, version), /deploy run failed: name conflict/);
  assert.deepEqual(
    calls.filter((args) => args[0] === "rm").map((args) => args.at(-1)),
    [containerName],
  );
});
