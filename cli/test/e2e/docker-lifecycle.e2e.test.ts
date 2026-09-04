import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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
} from "./harness.ts";

const SERVICES = ["core", "web-ui", "admin", "portal"] as const;
const suffix = (names: string[], end: string): string | undefined => names.find((n) => n.endsWith(`-${end}`));

function lifecycleSkip(): string | false {
  if (!dockerAvailable()) return "no Docker daemon reachable";
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
      botName: "straylight",
      orgName: "Straylight Industries",
      env: { core: { HARNESS: "mock" } },
      sandbox: { backend: "local", image: "qm-sandbox-local:latest" },
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

      await t.test("local sandbox mode gives only core the host Docker socket", () => {
        const names = deploymentContainers(org);
        const core = suffix(names, "core")!;
        const portal = suffix(names, "portal")!;
        const inspect = (container: string) =>
          JSON.parse(execFileSync("docker", ["inspect", container], { encoding: "utf8" }))[0] as {
            Config: { Env: string[] };
            Mounts: Array<{ Source: string; Destination: string }>;
          };
        const coreInfo = inspect(core);
        assert.ok(coreInfo.Config.Env.includes("DOCKER_HOST=unix:///var/run/docker.sock"));
        assert.ok(coreInfo.Config.Env.includes(`QM_CORE_CONTAINER=${core}`));
        assert.ok(coreInfo.Mounts.some((mount) => mount.Destination === "/var/run/docker.sock"));
        assert.ok(!inspect(portal).Mounts.some((mount) => mount.Destination === "/var/run/docker.sock"));
      });

      await t.test("services receive their private-network aliases", () => {
        const portal = suffix(deploymentContainers(org), "portal")!;
        const aliases = JSON.parse(
          execFileSync(
            "docker",
            ["inspect", "-f", `{{json (index .NetworkSettings.Networks "qm-${org}").Aliases}}`, portal],
            {
              encoding: "utf8",
            },
          ),
        ) as string[];
        assert.ok(aliases.includes(`qm-${org}-portal.internal`), aliases.join(", "));
      });

      await t.test("computed secrets from the deployment ./.env reach the core container", () => {
        const core = suffix(deploymentContainers(org), "core")!;
        const got = execFileSync("docker", ["exec", core, "printenv", "CORE_SIGNING_SECRET"], {
          encoding: "utf8",
        }).trim();
        assert.equal(got, sentinel);
      });

      await t.test("the configured bot identity reaches the core container and only the core container", () => {
        const names = deploymentContainers(org);
        const printenv = (container: string, name: string): string =>
          execFileSync("docker", ["exec", container, "printenv", name], { encoding: "utf8" }).trim();
        const core = suffix(names, "core")!;
        assert.equal(printenv(core, "ORG_BRAND_SELF_LABEL"), "straylight");
        assert.equal(printenv(core, "ORG_BRAND_ORG_NAME"), "Straylight Industries");
        assert.throws(() => printenv(suffix(names, "web-ui")!, "ORG_BRAND_SELF_LABEL"));
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
      });

      await t.test("logs for a non-existent service is a clear error", () => {
        const r = runCli(["logs", "doesnotexist"], { cwd: dep });
        assert.equal(r.code, 1);
        assert.match(r.out, /no container/);
      });

      await t.test("up is idempotent — re-running keeps the stack up", () => {
        const r = up();
        assert.equal(r.code, 0, r.out);
        assert.ok(suffix(deploymentContainers(org), "core"), "core still up after re-up");
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
