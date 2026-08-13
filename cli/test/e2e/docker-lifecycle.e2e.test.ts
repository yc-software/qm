import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDockerDeployProvider } from "../../../src/deploy/docker-deploy-provider.ts";
import type { Deployment, DeploymentVersion } from "../../../src/deploy/deploy-store.ts";
import { signRequest } from "../../../src/auth/source-auth.ts";
import { mintSignedPayload } from "../../../src/auth/signed-token.ts";
import {
  runCli,
  tmp,
  rmDir,
  writeConfig,
  standInCheckout,
  standInPlugin,
  dockerAvailable,
  deploymentContainers,
  deploymentVolumes,
  deploymentNetworks,
  dockerCleanup,
  removeStandInImages,
  preexistingServiceImages,
  repoRoot,
} from "./harness.ts";

const SERVICES = ["core", "web-ui", "admin", "portal"] as const;
const suffix = (names: string[], end: string): string | undefined => names.find((n) => n.endsWith(`-${end}`));

function lifecycleSkip(): string | false {
  if (!dockerAvailable()) return "no Docker daemon reachable";
  const engine = execFileSync("docker", ["version", "-f", "{{.Server.Version}}"], { encoding: "utf8" }).trim();
  if (Number(engine.match(/^(\d+)/)?.[1]) < 26) return `Docker Engine 26 or newer is required; found ${engine}`;
  const pre = preexistingServiceImages(SERVICES);
  if (pre.length) return `refusing to clobber your local images: ${pre.join(", ")} (docker rmi them to run this test)`;
  return false;
}

test(
  "docker lifecycle: up → status → logs → re-up → down → up → down --purge",
  { skip: lifecycleSkip() },
  async (t) => {
    const org = `qm-e2e-dl-${process.pid}`;
    const basePort = 20000 + (process.pid % 5000);
    const dep = tmp("dl-dep");
    const checkout = standInCheckout(SERVICES);
    const sentinel = `e2e-${process.pid}-sentinel-${"x".repeat(32)}`;
    let nestedProvider: ReturnType<typeof createDockerDeployProvider> | undefined;
    let nestedDeployment: Deployment | undefined;
    let nestedVersion: DeploymentVersion | undefined;
    let nestedEndpointHost: string | undefined;

    writeFileSync(
      join(dep, ".env"),
      [
        `CORE_SIGNING_SECRET=${sentinel}`,
        `CAPABILITY_SECRET=${sentinel}-capability`,
        `CONNECTOR_SECRET_KEY=${sentinel}-connector`,
        `PORTAL_IDENTITY_SECRET=${sentinel}-identity`,
        `SKILL_SIGNING_SECRET=${sentinel}-skill`,
        "OIDC_CLIENT_ID=fixture-client",
        `OIDC_CLIENT_SECRET=${sentinel}`,
        "PORTAL_EXPECTED_TEAM_ID=T123",
        `PORTAL_SESSION_SECRET=${sentinel}`,
        "",
      ].join("\n"),
    );
    writeConfig(dep, {
      orgId: org,
      target: "docker",
      basePort,
      services: [...SERVICES],
      env: { core: { HARNESS: "mock", SANDBOX_BACKEND: "local" } },
    });
    standInPlugin(dep, "widget");

    const up = (): ReturnType<typeof runCli> =>
      runCli(["up", "--build-from", checkout], { cwd: dep, env: { CORE_SIGNING_SECRET: undefined } });

    try {
      await t.test("up builds + starts every service, the source plugin, and Postgres", () => {
        const r = up();
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /stack up/);
        assert.match(r.out, new RegExp(`core   : http://localhost:${basePort}\\b`));
        assert.match(r.out, /plugin widget running/);

        const names = deploymentContainers(org);
        for (const svc of [...SERVICES, "widget", "pg"]) {
          assert.ok(suffix(names, svc), `expected a running container for ${svc}; got ${names.join(", ")}`);
        }
      });

      await t.test("computed secrets from the deployment ./.env reach the core container", () => {
        const core = suffix(deploymentContainers(org), "core")!;
        const got = execFileSync("docker", ["exec", core, "printenv", "CORE_SIGNING_SECRET"], {
          encoding: "utf8",
        }).trim();
        assert.equal(got, sentinel);
      });

      await t.test("core drives an isolated name-routed app through the shared Docker daemon", async () => {
        const core = suffix(deploymentContainers(org), "core")!;
        assert.ok(
          execFileSync("docker", ["exec", core, "docker", "version", "--format", "{{.Server.Version}}"], {
            encoding: "utf8",
          }).trim(),
        );
        const env = execFileSync("docker", ["exec", core, "env"], { encoding: "utf8" });
        assert.match(env, new RegExp(`^DOCKER_CORE_CONTAINER=qm-${org}-core$`, "m"));
        assert.match(env, new RegExp(`^DOCKER_CORE_DATA_VOLUME=qm-${org}-coredata$`, "m"));
        assert.match(env, new RegExp(`^DOCKER_DEPLOY_NETWORK=qm-${org}-deployments$`, "m"));
        const id = "12345678-1234-1234-1234-123456789abc";
        const snapshotDir = `/data/deployments/${id}`;
        execFileSync("docker", ["exec", core, "mkdir", "-p", snapshotDir]);
        execFileSync("docker", [
          "exec",
          core,
          "sh",
          "-c",
          `printf '%s' 'console.log("nested app"); require("node:http").createServer((req,res)=>res.end("nested-ok")).listen(process.env.PORT)' > ${snapshotDir}/server.js`,
        ]);
        nestedVersion = { version: 1, createdAt: 1, entrypoint: "node server.js", snapshotDir };
        nestedDeployment = {
          id,
          ownerScopeId: "personal:U1",
          createdBy: "U1",
          currentVersion: 1,
          status: "running",
          endpoint: null,
          versions: [nestedVersion],
        };
        nestedProvider = createDockerDeployProvider({
          coreContainer: core,
          coreDataVolume: `qm-${org}-coredata`,
          coreDataDir: "/data",
          network: `qm-${org}-deployments`,
          orgId: org,
        });
        const endpoint = await nestedProvider.apply(nestedDeployment, nestedVersion);
        assert.match(endpoint.host, /^agent-deploy-[a-f0-9]{24}$/);
        assert.equal(endpoint.port, 8080);
        nestedEndpointHost = endpoint.host;
        const app = endpoint.host;
        const ports = execFileSync("docker", ["inspect", app, "--format", "{{json .HostConfig.PortBindings}}"], {
          encoding: "utf8",
        });
        assert.doesNotMatch(ports, /HostPort/);
        let body = "";
        for (let i = 0; i < 30 && body !== "nested-ok"; i++) {
          try {
            body = execFileSync("docker", ["exec", core, "wget", "-qO-", `http://${endpoint.host}:8080`], {
              encoding: "utf8",
            });
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        assert.equal(body, "nested-ok");
      });

      await t.test("status enumerates exactly this deployment's containers with ports", () => {
        const r = runCli(["status"], { cwd: dep });
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /qm status/);
        assert.match(r.out, new RegExp(`qm-${org}-core\\b`));
        assert.match(r.out, /Up\b/);
        assert.match(r.out, new RegExp(`${basePort}->8080`));
      });

      await t.test("logs <service> tails one container; logs (all) interleaves with prefixes", () => {
        const one = runCli(["logs", "core", "--tail", "20"], { cwd: dep });
        assert.equal(one.code, 0, one.out);
        assert.match(one.out, /listening on :8080/);
        const tail1 = runCli(["logs", "core", "--tail", "1"], { cwd: dep });
        assert.equal(tail1.code, 0, tail1.out);
        assert.match(tail1.out, /tail sentinel/);
        assert.doesNotMatch(tail1.out, /listening on :8080/);

        const all = runCli(["logs", "--tail", "3"], { cwd: dep });
        assert.equal(all.code, 0, all.out);
        for (const label of [...SERVICES, "widget", "pg"]) {
          assert.match(all.out, new RegExp(`${label}\\s+\\|`), `interleaved logs missing ${label}`);
        }
        assert.ok(nestedEndpointHost);
        assert.match(all.out, new RegExp(`${nestedEndpointHost}\\s+\\|`));
      });

      await t.test("logs for a non-existent service is a clear error", () => {
        const r = runCli(["logs", "doesnotexist"], { cwd: dep });
        assert.equal(r.code, 1);
        assert.match(r.out, /no container/);
      });

      await t.test("up is idempotent — re-running keeps the stack up", () => {
        const r = up();
        assert.equal(r.code, 0, r.out);
        const core = suffix(deploymentContainers(org), "core")!;
        assert.ok(core, "core still up after re-up");
        assert.ok(nestedProvider && nestedDeployment && nestedVersion);
        return nestedProvider.resolveEndpoint!(nestedDeployment, nestedVersion).then((endpoint) => {
          assert.equal(endpoint?.host, nestedEndpointHost);
          assert.equal(endpoint?.port, 8080);
          const body = execFileSync("docker", ["exec", core, "wget", "-qO-", `http://${endpoint!.host}:8080`], {
            encoding: "utf8",
          });
          assert.equal(body, "nested-ok");
        });
      });

      await t.test("down (no purge) removes containers but keeps the network + volumes", () => {
        const r = runCli(["down"], { cwd: dep });
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /down\./);
        assert.deepEqual(deploymentContainers(org), []);
        assert.ok(deploymentVolumes(org).length > 0, "volumes preserved without --purge");
        assert.ok(deploymentNetworks(org).length > 0, "network preserved without --purge");
      });

      await t.test("up after down reuses the preserved Postgres volume + recorded password", () => {
        const r = up();
        assert.equal(r.code, 0, r.out);
        assert.ok(suffix(deploymentContainers(org), "core"), "stack back up");
      });

      await t.test("down --purge removes containers, the network, and the volumes", () => {
        const r = runCli(["down", "--purge"], { cwd: dep });
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /purging/);
        assert.deepEqual(deploymentContainers(org), []);
        assert.deepEqual(deploymentVolumes(org), []);
        assert.deepEqual(deploymentNetworks(org), []);
      });

      await t.test("the production core boots with local Docker topology from CLI defaults", async () => {
        const actualOrg = `${org}-actual`;
        const actualDep = tmp("dl-actual");
        try {
          writeFileSync(
            join(actualDep, ".env"),
            [
              `CORE_SIGNING_SECRET=${sentinel}-actual`,
              `CAPABILITY_SECRET=${sentinel}-actual-capability`,
              `CONNECTOR_SECRET_KEY=${sentinel}-actual-connector`,
              `PORTAL_IDENTITY_SECRET=${sentinel}-actual-identity`,
              `SKILL_SIGNING_SECRET=${sentinel}-actual-skill`,
              "",
            ].join("\n"),
          );
          writeConfig(actualDep, {
            orgId: actualOrg,
            target: "docker",
            basePort: basePort + 20,
            services: ["core"],
            env: { core: { HARNESS: "mock", SANDBOX_BACKEND: "local" } },
          });
          const upActual = runCli(["up", "--build-from", repoRoot], { cwd: actualDep, timeoutMs: 300_000 });
          assert.equal(upActual.code, 0, upActual.out);
          const core = suffix(deploymentContainers(actualOrg), "core")!;
          assert.equal(
            execFileSync("docker", ["exec", core, "printenv", "SANDBOX_BACKEND"], { encoding: "utf8" }).trim(),
            "local",
          );
          assert.ok(
            execFileSync("docker", ["exec", core, "docker", "version", "--format", "{{.Server.Version}}"], {
              encoding: "utf8",
            }).trim(),
          );
          const health = execFileSync("docker", ["exec", core, "wget", "-qO-", "http://127.0.0.1:8080/healthz"], {
            encoding: "utf8",
          });
          assert.match(health, /ok/);
          const path = "/v1/deployments";
          const body = JSON.stringify({
            ownerScopeId: "personal:U1",
            createdBy: "U1",
            entrypoint: "node server.js",
            files: [
              {
                path: "server.js",
                data: 'require("node:http").createServer((req,res)=>res.end("wired-ok")).listen(process.env.PORT)',
              },
            ],
            name: "wired-app",
          });
          const timestamp = Math.floor(Date.now() / 1000);
          const published = await fetch(`http://127.0.0.1:${basePort + 20}${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-timestamp": String(timestamp),
              "x-signature": signRequest(`${sentinel}-actual`, timestamp, `POST\n${path}\n${body}`),
              "x-portal-identity": await mintSignedPayload(
                { p: "U1", exp: Date.now() + 60_000 },
                `${sentinel}-actual-identity`,
              ),
            },
            body,
          });
          const publishedText = await published.text();
          assert.equal(published.status, 200, publishedText);
          const deployed = JSON.parse(publishedText) as { deployment: { endpoint: { host: string; port: number } } };
          assert.match(deployed.deployment.endpoint.host, /^agent-deploy-/);
          assert.equal(deployed.deployment.endpoint.port, 8080);
          let appBody = "";
          for (let attempt = 0; attempt < 30 && appBody !== "wired-ok"; attempt++) {
            try {
              appBody = execFileSync(
                "docker",
                ["exec", core, "wget", "-qO-", `http://${deployed.deployment.endpoint.host}:8080`],
                { encoding: "utf8" },
              );
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
          assert.equal(appBody, "wired-ok");
          const downActual = runCli(["down", "--purge"], { cwd: actualDep });
          assert.equal(downActual.code, 0, downActual.out);
          assert.deepEqual(deploymentContainers(actualOrg), []);
          assert.deepEqual(deploymentVolumes(actualOrg), []);
          assert.deepEqual(deploymentNetworks(actualOrg), []);
        } finally {
          dockerCleanup(actualOrg);
          rmDir(actualDep);
        }
      });
    } finally {
      dockerCleanup(org);
      removeStandInImages(SERVICES, org);
      rmDir(dep);
      rmDir(checkout);
    }
  },
);

test(
  "status on a deployment that was never brought up reports nothing running",
  { skip: dockerAvailable() ? false : "no Docker daemon reachable" },
  () => {
    const org = `qm-e2e-dl-empty-${process.pid}`;
    const dep = tmp("dl-empty");
    try {
      writeConfig(dep, { orgId: org, target: "docker", services: ["core"] });
      const r = runCli(["status"], { cwd: dep });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /qm status/);
      assert.deepEqual(deploymentContainers(org), []);
    } finally {
      dockerCleanup(org);
      rmDir(dep);
    }
  },
);

test(
  "down on a deployment that was never brought up is a clean no-op",
  { skip: dockerAvailable() ? false : "no Docker daemon reachable" },
  () => {
    const org = `qm-e2e-dl-noop-${process.pid}`;
    const dep = tmp("dl-noop");
    try {
      writeConfig(dep, { orgId: org, target: "docker", services: ["core"] });
      const r = runCli(["down"], { cwd: dep });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /down\./);
    } finally {
      dockerCleanup(org);
      rmDir(dep);
    }
  },
);
