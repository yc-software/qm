import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalSandbox,
  localContainerName,
  localNetworkName,
  localVolumeName,
} from "../src/sandbox/local-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { sleep } from "../src/util/async.ts";
import { scopeId } from "../src/types.ts";
import { installFakeDocker, type FakeDocker } from "./support/fake-docker.ts";

const tmp = mkdtempSync(join(tmpdir(), "local-sbx-"));
const guestHome = join(tmp, "home");
const controlProxyImage = "alpine/socat@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
let daemon: ChildProcess;
let daemonPort = 0;

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

before(async () => {
  daemonPort = await freePort();
  daemon = spawn(process.execPath, [join(process.cwd(), "aws/microvm-agent/agent.mjs")], {
    env: { ...process.env, AGENT_PORT: String(daemonPort), HOME: guestHome },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${daemonPort}/health`);
      if (res.status === 200) return;
    } catch {
      if (Date.now() > deadline) throw new Error("test daemon never became reachable");
    }
    await sleep(100);
  }
});

after(() => {
  daemon?.kill("SIGKILL");
});

function makeSandbox(fake: FakeDocker, opts: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "local-ws-"));
  return createLocalSandbox(createLocalWorkspaceStore(dir), {
    dockerExec: fake.dockerExec,
    homeDir: guestHome,
    repoRoot: tmp,
    ...opts,
  });
}
const rw = (scope: string) => [{ scopeId: scope, mountPath: "", mode: "rw" as const }];

test("profile declares the local Docker substrate honestly", () => {
  const sb = makeSandbox(installFakeDocker(daemonPort));
  assert.equal(sb.profile.backend, "local-docker");
  assert.equal(sb.profile.writablePersistence, "resident_disk");
  assert.equal(sb.profile.processSessions, true);
  assert.equal(supportsProcessSessions(sb), true);
});

test("a stopped Docker daemon fails provision with the actionable message", async () => {
  const fake = installFakeDocker(daemonPort);
  fake.daemonDown = true;
  const sb = makeSandbox(fake);
  await assert.rejects(
    sb.provision(rw(scopeId("personal", "U0"))),
    /requires a running Docker daemon \(is Docker Desktop running\?\)/,
  );
});

test("a label-inspection error does not misreport an existing image as missing", async () => {
  const fake = installFakeDocker(daemonPort);
  fake.labelInspectFails = true;
  const sb = makeSandbox(fake);
  const handle = await sb.provision(rw(scopeId("personal", "attested-image")));
  await sb.teardown(handle, { destroy: true });
});

test("a missing sandbox image fails provision with the build hint", async () => {
  const fake = installFakeDocker(daemonPort);
  fake.imageMissing = true;
  const sb = makeSandbox(fake);
  await assert.rejects(sb.provision(rw(scopeId("personal", "U0"))), /not found — run `npm run sandbox:local:build`/);
});

test("cold provision creates volume + container, run() execs over the daemon, bytes round-trip", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U1");
  const h = await sb.provision(rw(scope));
  assert.equal(h.id, localContainerName(scope));
  assert.equal(h.rootDir, `${guestHome}/workspace`);
  assert.equal(h.homeDir, guestHome);
  assert.equal(h.coldStart, true);
  assert.equal(fake.runCount, 1);
  assert.equal(fake.volumes.has(localVolumeName(scope)), true);
  const c = fake.containers.get(h.id)!;
  assert.equal(c.labels["qm.sandbox"], "1");
  assert.equal(c.labels["qm.scope"], scope);
  assert.equal(c.labels["qm.org"], "default-org");
  assert.equal(c.labels["agent_env"], "dev");
  assert.equal(c.volume, localVolumeName(scope));

  const r = await sb.run(h, "echo hello");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "hello");

  const payload = Uint8Array.from([0, 1, 2, 250, 251, 252]);
  await sb.writeFileBytes(h, "bin/blob.dat", payload);
  assert.deepEqual(Uint8Array.from((await sb.readFileBytes(h, "bin/blob.dat"))!), payload);
  assert.equal(await sb.readFileBytes(h, "bin/missing.dat"), null);
});

test("teardown parks the container and the next provision restarts it warm", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U2"));
  const h1 = await sb.provision(layers);
  await sb.teardown(h1);
  assert.equal(fake.containers.get(h1.id)!.running, false);

  const h2 = await sb.provision(layers);
  assert.equal(h2.id, h1.id, "same container reused");
  assert.equal(h2.coldStart, false);
  assert.equal(fake.runCount, 1, "no new container run");
  assert.equal(fake.containers.get(h1.id)!.running, true, "restarted");
});

test("a stale-image container is recreated while its home volume survives", async () => {
  const fake = installFakeDocker(daemonPort);
  const layers = rw(scopeId("personal", "U3"));
  const h1 = await makeSandbox(fake).provision(layers);
  const volume = fake.containers.get(h1.id)!.volume!;

  fake.imageId = "sha256:image-v2";
  const h2 = await makeSandbox(fake).provision(layers);
  assert.equal(h2.id, h1.id);
  assert.equal(fake.runCount, 2, "container recreated on the new image");
  assert.equal(fake.containers.get(h2.id)!.imageId, "sha256:image-v2");
  assert.equal(fake.volumes.has(volume), true, "volume survived the recreate");
  assert.equal(h2.coldStart, false, "existing volume means a warm home");
});

test("a scratch box has no volume and is removed on teardown", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const h = await sb.provision(rw(scopeId("personal", "U4")), { scratch: { key: "k1" } });
  assert.equal(h.scratch, true);
  assert.equal(h.coldStart, true);
  assert.equal(fake.containers.get(h.id)!.volume, undefined);
  await sb.teardown(h);
  assert.equal(fake.containers.has(h.id), false, "scratch container destroyed");
});

test("teardown destroy removes both the container and its volume", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U5");
  const h = await sb.provision(rw(scope));
  await sb.teardown(h, { destroy: true });
  assert.equal(fake.containers.has(h.id), false);
  assert.equal(fake.volumes.has(localVolumeName(scope)), false);
});

test("concurrent provisions for one scope run a single container", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U6"));
  const [a, b] = await Promise.all([sb.provision(layers), sb.provision(layers)]);
  assert.equal(a.id, b.id);
  assert.equal(fake.runCount, 1);
});

test("refcounted teardown: the container parks only after the last concurrent user releases", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U7"));
  const [a, b] = await Promise.all([sb.provision(layers), sb.provision(layers)]);
  await sb.teardown(a);
  assert.equal(fake.containers.get(a.id)!.running, true, "still held by the sibling");
  await sb.teardown(b);
  assert.equal(fake.containers.get(b.id)!.running, false, "parked after the last release");
});

test("process sessions: start, read output, signal to exit", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  assert.ok(supportsProcessSessions(sb));
  const h = await sb.provision(rw(scopeId("personal", "U8")));
  const { processId } = await sb.startProcess!(h, "echo started; sleep 30");
  let out = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !out.includes("started")) {
    const r = await sb.readProcess!(h, processId, { waitMs: 200 });
    out += r.chunks;
  }
  assert.match(out, /started/);
  await sb.signalProcess!(h, processId, "TERM");
  let status = (await sb.readProcess!(h, processId, {})).status;
  const exitDeadline = Date.now() + 10_000;
  while (status.state !== "exited" && Date.now() < exitDeadline) {
    await sleep(200);
    status = (await sb.readProcess!(h, processId, {})).status;
  }
  assert.equal(status.state, "exited");
});

test("an aborted run returns control promptly", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const h = await sb.provision(rw(scopeId("personal", "U9")));
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 150);
  const startedAt = Date.now();
  await sb.run(h, "sleep 30", { signal: ctl.signal }).catch(() => {});
  assert.ok(Date.now() - startedAt < 5_000, "run returned promptly after abort");
});

test("read-only layers materialize into the workspace once per content fingerprint", async () => {
  const fake = installFakeDocker(daemonPort);
  const dir = mkdtempSync(join(tmpdir(), "local-ws-"));
  const workspace = createLocalWorkspaceStore(dir);
  const shared = scopeId("org", "default-org");
  await workspace.write(shared, "guide.md", "shared doc");
  const sb = createLocalSandbox(workspace, { dockerExec: fake.dockerExec, homeDir: guestHome, repoRoot: tmp });
  const h = await sb.provision([
    { scopeId: scopeId("personal", "U10"), mountPath: "", mode: "rw" as const },
    { scopeId: shared, mountPath: "shared", mode: "ro" as const },
  ]);
  assert.equal(await sb.readFile(h, "shared/guide.md"), "shared doc");
});

test("each container runs on its own network; destroy removes it", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scopeA = scopeId("personal", "U20");
  const scopeB = scopeId("personal", "U21");
  const ha = await sb.provision(rw(scopeA));
  const hb = await sb.provision(rw(scopeB));
  const netA = localNetworkName(ha.id);
  const netB = localNetworkName(hb.id);
  assert.notEqual(netA, netB);
  assert.equal(fake.networks.has(netA), true);
  assert.equal(fake.networks.has(netB), true);
  await sb.teardown(ha, { destroy: true });
  assert.equal(fake.networks.has(netA), false);
  assert.equal(fake.networks.has(netB), true);
  await sb.teardown(hb);
});

test("concurrent teardown and provision for one scope serialize (no stop of a fresh user)", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U22");
  const h1 = await sb.provision(rw(scope));
  const [, h2] = await Promise.all([sb.teardown(h1), sb.provision(rw(scope))]);
  assert.equal(fake.containers.get(h2.id)!.running, true);
  const r = await sb.run(h2, "echo alive");
  assert.equal(r.stdout.trim(), "alive");
  await sb.teardown(h2);
  assert.equal(fake.containers.get(h2.id)!.running, false);
});

test("a replacement core reattaches to an already-running sandbox", async () => {
  const fake = installFakeDocker(daemonPort);
  const fetchImpl: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/health")) return Promise.resolve(new Response("", { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify({ code: 0, stdout: "", stderr: "", timedOut: false })));
  };
  const sb = makeSandbox(fake, { coreContainer: "qm-test-core", fetchImpl });
  const layers = rw(scopeId("personal", "U39"));
  const first = await sb.provision(layers);
  const connection = `${localNetworkName(first.id)}|qm-test-core`;
  assert.equal(fake.connections.has(connection), true);
  fake.connections.delete(connection);
  const second = await sb.provision(layers);
  assert.equal(second.id, first.id);
  assert.equal(fake.connections.has(connection), true);
  await sb.teardown(first);
  await sb.teardown(second, { destroy: true });
});

test("containerized core joins each sandbox network and reaches the daemon by container name", async () => {
  const fake = installFakeDocker(daemonPort);
  const seen: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input.toString();
    seen.push(url);
    if (url.endsWith("/health")) return Promise.resolve(new Response("", { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify({ code: 0, stdout: "", stderr: "", timedOut: false })));
  };
  const sb = makeSandbox(fake, { coreContainer: "qm-test-core", fetchImpl });
  const h = await sb.provision(rw(scopeId("personal", "U40")));
  const args = fake.containers.get(h.id)!.args;
  assert.equal(args.includes("-p"), false);
  assert.equal(fake.connections.has(`${localNetworkName(h.id)}|qm-test-core`), true);
  assert.ok(seen.includes(`http://${h.id}:8080/health`));
  await sb.teardown(h, { destroy: true });
  assert.equal(fake.connections.has(`${localNetworkName(h.id)}|qm-test-core`), false);
});

test("an isolated daemon publishes sandbox control only to its configured peer and denies sandbox egress", async () => {
  const fake = installFakeDocker(daemonPort);
  const seen: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input.toString();
    seen.push(url);
    if (url.endsWith("/health")) return Promise.resolve(new Response("", { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify({ code: 0, stdout: "", stderr: "", timedOut: false })));
  };
  const sb = makeSandbox(fake, {
    agentHost: "host.docker.internal",
    networkInternal: true,
    fetchImpl,
  });

  const h = await sb.provision(rw(scopeId("personal", "U41")));
  const args = fake.containers.get(h.id)!.args;
  assert.ok(fake.calls.some((call) => call.join(" ") === `network create --internal ${localNetworkName(h.id)}`));
  assert.ok(args.includes("-p"));
  assert.ok(seen.includes(`http://host.docker.internal:${daemonPort}/health`));
  assert.equal(fake.connections.size, 0);
  await sb.teardown(h, { destroy: true });
});

test("a workload control proxy bridges Core without exposing Core to the workload network", async () => {
  const fake = installFakeDocker(daemonPort);
  const seen: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input.toString();
    seen.push(url);
    if (url.endsWith("/health")) return Promise.resolve(new Response("", { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify({ code: 0, stdout: "", stderr: "", timedOut: false })));
  };
  const sb = makeSandbox(fake, {
    controlNetwork: "qm-control",
    controlProxyImage,
    networkInternal: true,
    fetchImpl,
  });

  const h = await sb.provision(rw(scopeId("personal", "U42")));
  const proxy = `qm-control-${h.id}`;
  assert.ok(fake.containers.has(proxy));
  assert.ok(fake.connections.has(`qm-control|${proxy}`));
  assert.ok(seen.includes(`http://${proxy}:8080/health`));
  const relay = fake.containers.get(proxy)!;
  for (const arg of ["--read-only", "--cap-drop", "--security-opt", "--pids-limit", "--memory", "--cpus", "--user"]) {
    assert.ok(relay.args.includes(arg), arg);
  }
  const workload = fake.containers.get(h.id)!;
  assert.equal(workload.args.includes("-p"), false);
  assert.equal(workload.args.includes("--add-host"), false);
  assert.equal(fake.connections.has(`${localNetworkName(h.id)}|qm-test-core`), false);
  await sb.teardown(h, { destroy: true });
});

test("a stale workload control proxy is recreated before reuse", async () => {
  const fake = installFakeDocker(daemonPort);
  const fetchImpl: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/health")) return Promise.resolve(new Response("", { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify({ code: 0, stdout: "", stderr: "", timedOut: false })));
  };
  const sb = makeSandbox(fake, {
    controlNetwork: "qm-control",
    controlProxyImage,
    networkInternal: true,
    fetchImpl,
  });
  const layers = rw(scopeId("personal", "U43"));
  const first = await sb.provision(layers);
  const proxy = `qm-control-${first.id}`;
  fake.imageId = "sha256:image-v2";

  const second = await sb.provision(layers);

  assert.equal(fake.containers.get(proxy)!.imageId, "sha256:image-v2");
  await sb.teardown(first);
  await sb.teardown(second, { destroy: true });
});

test("a tampered workload control proxy is recreated before reuse", async () => {
  const fake = installFakeDocker(daemonPort);
  const fetchImpl: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/health")) return Promise.resolve(new Response("", { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify({ code: 0, stdout: "", stderr: "", timedOut: false })));
  };
  const sb = makeSandbox(fake, {
    controlNetwork: "qm-control",
    controlProxyImage,
    networkInternal: true,
    fetchImpl,
  });
  const layers = rw(scopeId("personal", "U43-tampered"));
  const first = await sb.provision(layers);
  const proxy = `qm-control-${first.id}`;
  delete fake.containers.get(proxy)!.labels["qm.sandbox-control"];
  const before = fake.runCount;

  const second = await sb.provision(layers);

  assert.equal(fake.runCount, before + 1);
  await sb.teardown(first);
  await sb.teardown(second, { destroy: true });
});

test("a control proxy with an extra network is recreated before reuse", async () => {
  const fake = installFakeDocker(daemonPort);
  const fetchImpl: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/health")) return Promise.resolve(new Response("", { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify({ code: 0, stdout: "", stderr: "", timedOut: false })));
  };
  const sb = makeSandbox(fake, { controlNetwork: "qm-control", controlProxyImage, networkInternal: true, fetchImpl });
  const layers = rw(scopeId("personal", "U43-extra-network"));
  const first = await sb.provision(layers);
  const proxy = `qm-control-${first.id}`;
  fake.connections.add(`shared-network|${proxy}`);
  const before = fake.runCount;

  const second = await sb.provision(layers);

  assert.equal(fake.runCount, before + 1);
  await sb.teardown(first);
  await sb.teardown(second, { destroy: true });
});

test("a failed control-proxy health check removes the workload and relay", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake, {
    controlNetwork: "qm-control",
    controlProxyImage,
    networkInternal: true,
    daemonReadyTimeoutMs: 50,
    fetchImpl: () => Promise.resolve(new Response("", { status: 503 })),
  });
  const scope = scopeId("personal", "U44");
  const name = localContainerName(scope);

  await assert.rejects(sb.provision(rw(scope)), /exec daemon never became reachable/);

  assert.equal(fake.containers.has(name), false);
  assert.equal(fake.containers.has(`qm-control-${name}`), false);
  assert.equal(fake.networks.has(localNetworkName(name)), false);
});

test("control mode fails closed unless its sandbox network is internal", () => {
  const workspace = createLocalWorkspaceStore("/tmp/qm-control-mode-validation");
  assert.throws(
    () => createLocalSandbox(workspace, { controlNetwork: "qm-control", controlProxyImage: "alpine/socat:1.8.0.0" }),
    /requires networkInternal=true/,
  );
  assert.throws(
    () =>
      createLocalSandbox(workspace, {
        controlNetwork: "qm-control",
        controlProxyImage: "alpine/socat:1.8.0.0",
        networkInternal: false,
      }),
    /requires networkInternal=true/,
  );
});

test("control mode rejects a mutable sandbox control proxy image", () => {
  const workspace = createLocalWorkspaceStore("/tmp/qm-control-image-validation");
  assert.throws(
    () =>
      createLocalSandbox(workspace, {
        controlNetwork: "qm-control",
        controlProxyImage: "alpine/socat:1.8.0.0",
        networkInternal: true,
      }),
    /immutable digest/,
  );
});

test("a missing control proxy does not prevent sandbox resource cleanup", async () => {
  const fake = installFakeDocker(daemonPort);
  const fetchImpl: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(
      new Response(url.endsWith("/health") ? "" : JSON.stringify({ code: 0, stdout: "", stderr: "", timedOut: false })),
    );
  };
  const sb = makeSandbox(fake, {
    controlNetwork: "qm-control",
    controlProxyImage,
    networkInternal: true,
    fetchImpl,
  });
  const handle = await sb.provision(rw(scopeId("personal", "U45")));
  fake.containers.delete(`qm-control-${handle.id}`);

  await sb.teardown(handle, { destroy: true });

  assert.equal(fake.containers.has(handle.id), false);
  assert.equal(fake.networks.has(localNetworkName(handle.id)), false);
  assert.equal(fake.volumes.has(localVolumeName(scopeId("personal", "U45"))), false);
});
